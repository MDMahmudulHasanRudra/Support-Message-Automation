import { describe, expect, it } from "vitest";
import { bridgeEvidence, decideAttribution, echoAccountCandidate, parseDriveActivity, personIdOf, type DriveActivityRecord } from "../googleSheets/driveActivity.js";

/**
 * Google Sheets Phase 8 — reading Drive Activity (GOOGLE_SHEETS.md §3). Pure; safe against any
 * database. The crediting rule is the point: crediting the wrong employee is worse than crediting
 * nobody, so only ONE known actor, linked by the person themselves, with the id format confirmed.
 */

const known = (id: string, isCurrentUser = false) => ({ user: { knownUser: { personName: `people/${id}`, isCurrentUser } } });
const activity = (actors: unknown[], detail: Record<string, unknown> = { edit: {} }, timestamp = "2026-10-09T05:00:00.000Z") => ({
  primaryActionDetail: detail,
  actors,
  targets: [{ driveItem: { name: "items/file-1" } }],
  timestamp,
});

describe("parseDriveActivity", () => {
  it("reads the action, the actors and the time", () => {
    const r = parseDriveActivity(activity([known("111", true)]), "file-1")!;
    expect(r.actionType).toBe("EXTERNAL_EDIT");
    expect(r.occurredAt.toISOString()).toBe("2026-10-09T05:00:00.000Z");
    expect(r.actors).toEqual([{ kind: "KNOWN_USER", personId: "111", isCurrentUser: true }]);
  });

  it("maps each Google action, and anything else to 'other'", () => {
    const kinds = ["edit", "create", "rename", "delete", "restore", "comment", "permissionChange", "move", "dlpChange"].map(
      (key) => parseDriveActivity(activity([known("1")], { [key]: {} }), "f")!.actionType,
    );
    expect(kinds).toEqual([
      "EXTERNAL_EDIT",
      "EXTERNAL_CREATE",
      "EXTERNAL_RENAME",
      "EXTERNAL_DELETE",
      "EXTERNAL_RESTORE",
      "EXTERNAL_COMMENT",
      "EXTERNAL_PERMISSION_CHANGE",
      "EXTERNAL_MOVE",
      "EXTERNAL_OTHER",
    ]);
  });

  it("reads every kind of actor Google can name", () => {
    const r = parseDriveActivity(
      activity([
        { user: { deletedUser: {} } },
        { user: { unknownUser: {} } },
        { anonymous: {} },
        { impersonation: { impersonatedUser: known("9").user } },
        { system: { type: "DATA_LOSS_PREVENTION" } },
        { administrator: {} },
        {},
      ]),
      "f",
    )!;
    expect(r.actors.map((a) => a.kind)).toEqual(["DELETED_USER", "UNKNOWN_USER", "ANONYMOUS", "IMPERSONATION", "SYSTEM", "ADMINISTRATOR", "OTHER"]);
  });

  it("uses a time range's end when there is no timestamp, and drops a record with no time", () => {
    const ranged = parseDriveActivity({ primaryActionDetail: { edit: {} }, actors: [known("1")], timeRange: { startTime: "2026-10-09T04:00:00Z", endTime: "2026-10-09T04:30:00Z" } }, "f")!;
    expect(ranged.occurredAt.toISOString()).toBe("2026-10-09T04:30:00.000Z");
    expect(parseDriveActivity({ primaryActionDetail: { edit: {} }, actors: [] }, "f")).toBeNull();
    expect(parseDriveActivity("nonsense", "f")).toBeNull();
  });

  it("gives the same record the same key every time — and a different change a different key", () => {
    const a = parseDriveActivity(activity([known("1")]), "f")!.key;
    expect(parseDriveActivity(activity([known("1")]), "f")!.key).toBe(a);
    expect(parseDriveActivity(activity([known("2")]), "f")!.key).not.toBe(a);
    expect(parseDriveActivity(activity([known("1")], { rename: {} }), "f")!.key).not.toBe(a);
    expect(parseDriveActivity(activity([known("1")], { edit: {} }, "2026-10-09T05:00:01.000Z"), "f")!.key).not.toBe(a);
    expect(parseDriveActivity(activity([known("1")]), "other-file")!.key).not.toBe(a);
  });

  it("reads people ids only in Google's form", () => {
    expect(personIdOf("people/123")).toBe("123");
    expect(personIdOf("users/123")).toBeNull();
    expect(personIdOf(undefined)).toBeNull();
  });
});

describe("decideAttribution", () => {
  const rec = (actors: DriveActivityRecord["actors"]): DriveActivityRecord => ({ key: "k", occurredAt: new Date(), actionType: "EXTERNAL_EDIT", actors });
  const identities = new Map([["555", "user-borhan"]]);
  const verified = { bridge: "VERIFIED" as const, identities };

  it("credits ONE known actor whose Google identity the person linked themselves", () => {
    expect(decideAttribution(rec([{ kind: "KNOWN_USER", personId: "555", isCurrentUser: false }]), verified)).toEqual({ attribution: "ATTRIBUTED", userId: "user-borhan", personId: "555" });
  });

  it("credits nobody when the account is linked to nobody", () => {
    expect(decideAttribution(rec([{ kind: "KNOWN_USER", personId: "777", isCurrentUser: false }]), verified)).toMatchObject({ attribution: "UNATTRIBUTED", reason: "NO_LINKED_IDENTITY" });
  });

  it("credits nobody until Google has been seen to use sign-in's ids — and never after a mismatch", () => {
    const actor = rec([{ kind: "KNOWN_USER", personId: "555", isCurrentUser: false }]);
    expect(decideAttribution(actor, { bridge: "UNVERIFIED", identities })).toMatchObject({ attribution: "UNATTRIBUTED", reason: "BRIDGE_UNVERIFIED" });
    expect(decideAttribution(actor, { bridge: "MISMATCH", identities })).toMatchObject({ attribution: "UNATTRIBUTED", reason: "BRIDGE_MISMATCH" });
  });

  it("credits nobody when Google names several people, or anyone but a known user", () => {
    expect(
      decideAttribution(
        rec([
          { kind: "KNOWN_USER", personId: "555", isCurrentUser: false },
          { kind: "KNOWN_USER", personId: "666", isCurrentUser: false },
        ]),
        verified,
      ),
    ).toMatchObject({ attribution: "UNATTRIBUTED", reason: "SEVERAL_ACTORS" });
    for (const kind of ["DELETED_USER", "UNKNOWN_USER", "ANONYMOUS", "IMPERSONATION", "SYSTEM", "ADMINISTRATOR"] as const) {
      expect(decideAttribution(rec([{ kind }]), verified)).toMatchObject({ attribution: "UNATTRIBUTED", reason: kind });
    }
    expect(decideAttribution(rec([]), verified)).toMatchObject({ attribution: "UNATTRIBUTED", reason: "OTHER" });
    expect(decideAttribution(rec([{ kind: "KNOWN_USER", personId: null, isCurrentUser: false }]), verified)).toMatchObject({ reason: "UNKNOWN_USER" });
  });
});

describe("the identity bridge and echoes", () => {
  const own = (personId: string): DriveActivityRecord => ({ key: "k", occurredAt: new Date(), actionType: "EXTERNAL_EDIT", actors: [{ kind: "KNOWN_USER", personId, isCurrentUser: true }] });

  it("an account's own change proves or disproves that Google's id is its sign-in id", () => {
    expect(bridgeEvidence(own("1234"), "1234")).toBe("MATCH");
    expect(bridgeEvidence(own("9999"), "1234")).toBe("MISMATCH");
    expect(bridgeEvidence({ ...own("1234"), actors: [{ kind: "KNOWN_USER", personId: "1234", isCurrentUser: false }] }, "1234")).toBeNull();
  });

  it("an echo comes from the reading account itself, or — once verified — another connected account", () => {
    const accountsBySubject = new Map([["2222", "acc-2"]]);
    expect(echoAccountCandidate(own("1111"), { pollingAccountId: "acc-1", bridge: "UNVERIFIED", accountsBySubject })).toBe("acc-1");
    const other: DriveActivityRecord = { ...own("2222"), actors: [{ kind: "KNOWN_USER", personId: "2222", isCurrentUser: false }] };
    expect(echoAccountCandidate(other, { pollingAccountId: "acc-1", bridge: "UNVERIFIED", accountsBySubject })).toBeNull();
    expect(echoAccountCandidate(other, { pollingAccountId: "acc-1", bridge: "VERIFIED", accountsBySubject })).toBe("acc-2");
  });
});
