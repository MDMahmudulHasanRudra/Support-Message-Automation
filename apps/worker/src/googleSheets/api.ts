/**
 * The worker's Google HTTP calls (GOOGLE_SHEETS.md, Phase 8): refreshing a connected account's access
 * and reading Drive Activity. Plain `fetch`, no SDK — the same choice as the dashboard's
 * `apps/web/src/server/google/api.ts`, which owns every other Google call. `fetchImpl` is injectable
 * so tests never touch the network.
 */

export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const DRIVE_ACTIVITY_ENDPOINT = "https://driveactivity.googleapis.com/v2/activity:query";
export const DRIVE_ACTIVITY_SCOPE = "https://www.googleapis.com/auth/drive.activity.readonly";

export type FetchImpl = typeof fetch;

export class GoogleApiError extends Error {
  constructor(
    message: string,
    public readonly code: string | null,
    public readonly status: number,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }

  /** The stored grant is dead (revoked, expired, password changed): only a person reconnecting helps. */
  get needsReconnect(): boolean {
    return this.code === "invalid_grant" || this.status === 401;
  }
}

async function readError(response: Response): Promise<GoogleApiError> {
  let code: string | null = null;
  let detail = "";
  try {
    const body = (await response.json()) as { error?: string | { message?: string; status?: string; errors?: Array<{ reason?: string }> }; error_description?: string };
    if (typeof body.error === "string") {
      code = body.error;
      detail = body.error_description ?? "";
    } else if (body.error) {
      code = body.error.errors?.[0]?.reason ?? body.error.status ?? null;
      detail = body.error.message ?? "";
    }
  } catch {
    /* not JSON */
  }
  return new GoogleApiError(`Google answered ${response.status}${code ? ` (${code})` : ""}${detail ? `: ${detail}` : ""}`, code, response.status);
}

export async function refreshAccessToken(
  config: { clientId: string; clientSecret: string },
  refreshToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: Date }> {
  const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  if (!response.ok) throw await readError(response);
  const body = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!body.access_token) throw new GoogleApiError("Google returned no access token.", null, 200);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    // A minute early, so a token is never used in its last seconds.
    expiresAt: new Date(Date.now() + Math.max(0, (body.expires_in ?? 3600) - 60) * 1000),
  };
}

/** The most pages one read takes (100 activities each); the rest is read next time. */
export const MAX_ACTIVITY_PAGES = 50;

/**
 * Drive Activity for ONE file since an instant (`activity:query`, `itemName: items/<id>`). No
 * consolidation strategy is sent, so related actions are NOT merged into one activity spanning
 * several people. Returns Google's raw activity objects; `driveActivity.ts` reads them.
 */
export async function queryDriveActivity(
  accessToken: string,
  fileId: string,
  since: Date,
  fetchImpl: FetchImpl = fetch,
): Promise<{ activities: unknown[]; complete: boolean }> {
  const activities: unknown[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_ACTIVITY_PAGES; page++) {
    const response = await fetchImpl(DRIVE_ACTIVITY_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ itemName: `items/${fileId}`, filter: `time >= "${since.toISOString()}"`, pageSize: 100, ...(pageToken ? { pageToken } : {}) }),
    });
    if (!response.ok) throw await readError(response);
    const body = (await response.json()) as { activities?: unknown[]; nextPageToken?: string };
    activities.push(...(body.activities ?? []));
    pageToken = body.nextPageToken;
    if (!pageToken) return { activities, complete: true };
  }
  return { activities, complete: false };
}
