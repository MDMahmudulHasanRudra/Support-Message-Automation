import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma, encryptSecret } from "@support-automation/db";
import { TeamsOAuthError } from "@support-automation/teams-client";

/**
 * Covers the one-click connection UX refinement's token-refresh classification: a rejected
 * refresh token (invalid_grant — the customer revoked consent, or it genuinely expired) must move
 * the account to REAUTH_REQUIRED, never a generic ERROR that would make the worker keep retrying a
 * refresh that can only ever fail again. A transient failure (network blip, Graph outage) must stay
 * ERROR and keep being retried automatically. Mocks TeamsAuthClient only — everything else
 * (classifyTokenError, the TeamsAccount read/write) is real, against the isolated test DB.
 */

vi.mock("@support-automation/teams-client", async () => {
  const actual = await vi.importActual<typeof import("@support-automation/teams-client")>("@support-automation/teams-client");
  return {
    ...actual,
    TeamsAuthClient: vi.fn(),
  };
});

const ENV_KEYS = ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_TENANT_ID", "MICROSOFT_REDIRECT_URI"] as const;
let originalEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.MICROSOFT_CLIENT_ID = "test-client-id";
  process.env.MICROSOFT_CLIENT_SECRET = "test-client-secret";
  process.env.MICROSOFT_TENANT_ID = "test-tenant-id";
  process.env.MICROSOFT_REDIRECT_URI = "https://example.invalid/api/teams/callback";
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

async function seedConnectedAccount() {
  await prisma.teamsAccount.upsert({
    where: { id: "global" },
    update: {
      status: "CONNECTED",
      accessTokenCiphertext: encryptSecret("old-access-token"),
      refreshTokenCiphertext: encryptSecret("old-refresh-token"),
      tokenExpiresAt: new Date(Date.now() - 60_000), // already expired -> forces a refresh attempt
      lastSyncError: null,
    },
    create: {
      id: "global",
      status: "CONNECTED",
      accessTokenCiphertext: encryptSecret("old-access-token"),
      refreshTokenCiphertext: encryptSecret("old-refresh-token"),
      tokenExpiresAt: new Date(Date.now() - 60_000),
    },
  });
}

afterEach(async () => {
  vi.resetModules();
  await prisma.teamsAccount.update({
    where: { id: "global" },
    data: { status: "DISCONNECTED", accessTokenCiphertext: null, refreshTokenCiphertext: null, tokenExpiresAt: null, lastSyncError: null },
  });
});

describe("getValidTeamsAccessToken", () => {
  it("moves the account to REAUTH_REQUIRED when Microsoft rejects the refresh token with invalid_grant", async () => {
    const { TeamsAuthClient } = await import("@support-automation/teams-client");
    (TeamsAuthClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      refreshAccessToken: vi.fn().mockRejectedValue(new TeamsOAuthError("refresh token expired", "invalid_grant")),
    }));

    await seedConnectedAccount();
    const { getValidTeamsAccessToken } = await import("../teams/tokenRefresh.js");

    const token = await getValidTeamsAccessToken();
    expect(token).toBeNull();

    const account = await prisma.teamsAccount.findUniqueOrThrow({ where: { id: "global" } });
    expect(account.status).toBe("REAUTH_REQUIRED");
  });

  it("keeps the account at ERROR (not REAUTH_REQUIRED) on a transient refresh failure", async () => {
    const { TeamsAuthClient } = await import("@support-automation/teams-client");
    (TeamsAuthClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      refreshAccessToken: vi.fn().mockRejectedValue(new TeamsOAuthError("temporarily unavailable", "temporarily_unavailable")),
    }));

    await seedConnectedAccount();
    const { getValidTeamsAccessToken } = await import("../teams/tokenRefresh.js");

    const token = await getValidTeamsAccessToken();
    expect(token).toBeNull();

    const account = await prisma.teamsAccount.findUniqueOrThrow({ where: { id: "global" } });
    expect(account.status).toBe("ERROR");
  });

  it("never attempts a refresh when the account already needs reauthentication", async () => {
    await prisma.teamsAccount.update({
      where: { id: "global" },
      data: {
        status: "REAUTH_REQUIRED",
        accessTokenCiphertext: encryptSecret("stale-access-token"),
        refreshTokenCiphertext: encryptSecret("stale-refresh-token"),
        tokenExpiresAt: new Date(Date.now() - 60_000),
      },
    });
    const { TeamsAuthClient } = await import("@support-automation/teams-client");
    const refreshSpy = vi.fn();
    (TeamsAuthClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({ refreshAccessToken: refreshSpy }));

    const { getValidTeamsAccessToken } = await import("../teams/tokenRefresh.js");
    const token = await getValidTeamsAccessToken();

    expect(token).toBeNull();
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});
