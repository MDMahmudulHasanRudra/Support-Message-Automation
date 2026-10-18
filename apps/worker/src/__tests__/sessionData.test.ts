import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasRestorableSessionData } from "../provider/openwa/sessionData.js";

/**
 * The guard that decides whether a Chromium profile may be deleted after an attempt produced no
 * code at all.
 *
 * It used to ask `access()` — is the file there — and on 24 Sep 2026 that kept a live account down
 * for a day. `@open-wa/wa-automate` had written a four-byte `{}`, which is what a multi-device
 * session leaves behind: the credentials live in the profile's IndexedDB, and this file has nothing
 * to hold. The guard read it as "a restore is possible", so the profile that was failing every
 * attempt was never cleared, no QR was ever produced, and there was no way to link the account back
 * without deleting the file by hand.
 *
 * Real files in a real temp directory, because the bug was entirely about what is IN the file.
 */
describe("hasRestorableSessionData", () => {
  let dir: string;
  const SESSION = "support-automation";
  const file = () => join(dir, `${SESSION}.data.json`);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "session-data-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("answers false for the empty object a multi-device session leaves behind — the production bug", async () => {
    await writeFile(file(), "{}");
    expect(await hasRestorableSessionData(dir, SESSION)).toBe(false);
  });

  it("answers false when there is no file at all", async () => {
    expect(await hasRestorableSessionData(dir, SESSION)).toBe(false);
  });

  it("answers false for an empty file, and for whitespace", async () => {
    await writeFile(file(), "");
    expect(await hasRestorableSessionData(dir, SESSION)).toBe(false);
    await writeFile(file(), "  \n ");
    expect(await hasRestorableSessionData(dir, SESSION)).toBe(false);
  });

  it("answers false for content that is not JSON, rather than throwing", async () => {
    await writeFile(file(), "not json at all");
    await expect(hasRestorableSessionData(dir, SESSION)).resolves.toBe(false);
  });

  it("answers false for JSON that is not an object", async () => {
    for (const raw of ["null", "42", '"session"', "[]", "[1,2]"]) {
      await writeFile(file(), raw);
      expect(await hasRestorableSessionData(dir, SESSION)).toBe(false);
    }
  });

  it("answers true for a session object with anything in it, so a real session is never destroyed", async () => {
    await writeFile(file(), JSON.stringify({ WABrowserId: '"abc"', WASecretBundle: "{}" }));
    expect(await hasRestorableSessionData(dir, SESSION)).toBe(true);
  });

  it("is generous: a shape it does not recognise still counts as a session", async () => {
    await writeFile(file(), JSON.stringify({ somethingNobodyHasSeenYet: true }));
    expect(await hasRestorableSessionData(dir, SESSION)).toBe(true);
  });

  it("reads the file belonging to THIS session id", async () => {
    await writeFile(join(dir, "another-session.data.json"), JSON.stringify({ WABrowserId: "x" }));
    expect(await hasRestorableSessionData(dir, SESSION)).toBe(false);
  });
});
