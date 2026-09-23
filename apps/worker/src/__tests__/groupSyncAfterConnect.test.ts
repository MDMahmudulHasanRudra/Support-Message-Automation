import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Every path that brings a session up has to reconcile the group list. All three, not one.
 *
 * WHAT WENT WRONG. There are three ways an account gets connected, and only
 * `ProviderRegistry.connectAccount()` chained a group sync. The RECONNECT command — which is what
 * the dashboard's Connect and Reconnect buttons issue — and `recoverIfDropped()` both connected and
 * stopped. So an account linked from the dashboard came up CONNECTED against whatever group rows
 * happened to be there already: on a number just logged out that is every row marked
 * `isActive: false` by the LOGOUT handler, and on a fresh account it is none at all. A healthy
 * session with a dead group list, and nothing saying why.
 *
 * It was made likely rather than rare by the interaction between the two paths. RECONNECT's first
 * act is `provider.disconnect()`, which abandons the registry's own in-flight connect if one is
 * waiting for a scan — so pressing Connect during a link discards the attempt that WOULD have
 * synced and hands the session to the one that does not. Hit in production on 23 Sep 2026,
 * immediately after a deploy and a successful QR scan: groups never appeared.
 *
 * Asserted against the source because what is being protected is that three call sites exist. A
 * behavioural test can only ever cover the path it drives, and the failure here was an ABSENCE at a
 * site nothing drove. Pure — no database, no browser.
 */

const read = (p: string) => readFileSync(resolve(__dirname, p), "utf8");

const commandProcessor = read("../commands/commandProcessor.ts");
const providerRegistry = read("../provider/ProviderRegistry.ts");
const registrySync = read("../provider/accountRegistrySync.ts");

describe("all three connect paths reconcile the group list", () => {
  it("there is one shared routine rather than three copies", () => {
    // Three copies is how they drifted apart in the first place — the registry grew a sync and a
    // catch-up, and the other two were written without either.
    expect(commandProcessor).toContain("export function resyncAndCatchUpAfterConnect(");
  });

  it("the RECONNECT command runs it", () => {
    // The path the dashboard's Connect and Reconnect buttons both take.
    const reconnect = commandProcessor.slice(
      commandProcessor.indexOf('case "RECONNECT"'),
      commandProcessor.indexOf('case "LOGOUT"'),
    );
    expect(reconnect).toContain("resyncAndCatchUpAfterConnect(accountId, provider,");
  });

  it("the registry's initial connect runs it", () => {
    expect(providerRegistry).toContain("resyncAndCatchUpAfterConnect(account.id, provider,");
  });

  it("automatic drop recovery runs it, and only when the session actually came back", () => {
    expect(registrySync).toContain("resyncAndCatchUpAfterConnect(accountId, provider,");
    // Inside the CONNECTED branch. A sync against a provider that never reconnected reads an empty
    // roster, and an empty roster is the one input `syncGroups`' deactivation sweep refuses to act
    // on for exactly that reason — so it would be pure cost with a misleading log line.
    const connectedBranch = registrySync.slice(
      registrySync.indexOf('if (outcome === "CONNECTED")'),
      registrySync.indexOf("} else {", registrySync.indexOf('if (outcome === "CONNECTED")')),
    );
    expect(connectedBranch).toContain("resyncAndCatchUpAfterConnect(");
  });
});

describe("the routine's shape is what makes it safe to call from all three", () => {
  const routine = commandProcessor.slice(
    commandProcessor.indexOf("export function resyncAndCatchUpAfterConnect("),
    commandProcessor.indexOf("const COMMAND_STUCK_TIMEOUT_MS"),
  );

  it("catch-up runs AFTER the sync, never beside it", () => {
    // The ordering the registry chose and documented: a message recovered from a group that is not
    // in the database yet files under no group at all.
    const syncAt = routine.indexOf("syncGroupsWithTimeoutAndRetry");
    const catchUpAt = routine.indexOf("catchUpMissedMessages");
    expect(syncAt).toBeGreaterThan(-1);
    expect(catchUpAt).toBeGreaterThan(syncAt);
  });

  it("it is fire-and-forget, so it cannot hold the serial command processor", () => {
    // Three attempts at up to 150s plus backoff is roughly eight minutes. Awaiting that inside the
    // command processor would park Show QR, Logout and every other account's commands behind one
    // account's roster.
    expect(routine).not.toMatch(/await\s+syncGroupsWithTimeoutAndRetry/);
    expect(routine).toContain("): void {");
  });

  it("a failed sync says what it costs, rather than passing silently", () => {
    // The session stays up, so nothing else will report it — and a stale group list looks exactly
    // like a quiet one.
    expect(routine).toContain("Press Resync Groups.");
  });
});
