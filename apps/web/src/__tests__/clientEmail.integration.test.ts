import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { createProjectWithDefaults, decryptSecret, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Email (SMTP) settings (CLIENT_CENTER_PLAN.md §3.1, stage 4C), in separate projects.
 *
 * What must hold:
 *   - every action needs `communications.manage_email` (an authorized admin's key, not clients.update)
 *     and refuses when the project's CLIENT_CENTER feature is off;
 *   - the password is encrypted at rest, never returned to a page, never echoed back with a refusal
 *     and never written to a log;
 *   - the channel is "connected" only after a test message was accepted under the settings as they are
 *     NOW — changing the host, port, security, username, password or sender returns it to "needs retest",
 *     changing only the name, reply-to or limits does not;
 *   - a test goes only to the signed-in administrator's own address, one at a time;
 *   - one project's settings, credentials and queue are invisible to another.
 */

process.env.AI_CREDENTIALS_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ids = { roles: [] as string[], users: [] as string[], projects: [] as string[] };

vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/x${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const actions = await import("@/server/actions/emailSettings");
const reads = await import("@/server/emailSettings");

type Project = { id: string; slug: string; name: string; status: "ACTIVE" };
let A: Project;
let B: Project;
let C: Project; // CLIENT_CENTER never switched on

async function role(name: string, keys: string[]) {
  const permissions = await Promise.all(
    keys.map((key) => {
      const def = PERMISSIONS.find((p) => p.key === key)!;
      return rawPrisma.permission.upsert({ where: { key }, create: { key, label: def.label, category: def.category }, update: {}, select: { id: true } });
    }),
  );
  const r = await rawPrisma.permissionModule.create({ data: { name: `${name} ${tag}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
  ids.roles.push(r.id);
  return r.id;
}
async function user(name: string, roleId: string, email?: string): Promise<Session> {
  const u = await rawPrisma.user.create({ data: { username: `${name.toLowerCase()}_${tag}`, email: email ?? `${name.toLowerCase()}.${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId } });
  ids.users.push(u.id);
  return { userId: u.id, username: u.username, email: u.email!, name } as Session;
}
const people = {} as Record<"admin" | "editor", Session>;
const as = <T,>(person: Session, project: Project, fn: () => Promise<T>) => {
  current = person;
  return runWithProject(project, fn);
};
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const GOOD = { host: "smtp.example.test", port: "587", tlsMode: "STARTTLS", username: "mailer", password: `secret-${tag}`, fromName: "Support", fromAddress: "support@example.test", replyTo: "", maxPerMinute: "10", maxPerDay: "500" };
const save = (project: Project, fields: Record<string, string> = {}, person = people.admin) => as(person, project, () => actions.saveEmailSettings({}, form({ ...GOOD, ...fields })));
const stored = (project: Project) => rawPrisma.emailSettings.findFirstOrThrow({ where: { projectId: project.id } });
const view = (project: Project) => as(people.admin, project, () => reads.getEmailSettingsView());
/** What the worker does when a test message is accepted. */
const verify = async (project: Project) => {
  const s = await stored(project);
  await rawPrisma.emailSettings.update({ where: { id: s.id }, data: { verifiedVersion: s.settingsVersion, lastTestOk: true, lastTestAt: new Date() } });
};

beforeAll(async () => {
  people.admin = await user("Admin", await role("EM admin", ["clients.view", "communications.manage_email", "messages.view"]));
  people.editor = await user("Editor", await role("EM editor", ["clients.view", "clients.create", "clients.update", "clients.link_whatsapp_chat", "clients.edit_billing", "messages.view"]));
  const make = async (name: string, withFeature: boolean) => {
    const p = await createProjectWithDefaults({ name: `${name} ${tag}`, slug: `${name.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: people.admin.userId }, rawPrisma);
    ids.projects.push(p.id);
    await rawPrisma.projectAccess.createMany({ data: Object.values(people).map((u) => ({ projectId: p.id, userId: u.userId })), skipDuplicates: true });
    if (withFeature) await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: p.id, key: "CLIENT_CENTER" } }, create: { projectId: p.id, key: "CLIENT_CENTER", enabled: true }, update: { enabled: true } });
    return { id: p.id, slug: p.slug, name: `${name} ${tag}`, status: "ACTIVE" as const };
  };
  A = await make("MailA", true);
  B = await make("MailB", true);
  C = await make("MailC", false);
  forgetProjectFeatureStates();
});

afterAll(async () => {
  const where = { projectId: { in: ids.projects } };
  await rawPrisma.emailOutbox.deleteMany({ where });
  await rawPrisma.emailSettings.deleteMany({ where });
  await rawPrisma.systemLog.deleteMany({ where });
  await rawPrisma.projectFeature.deleteMany({ where });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  forgetProjectFeatureStates();
});

describe("1. permissions and the feature switch", () => {
  it("refuses every action without communications.manage_email, even to someone who can edit clients", async () => {
    expect((await save(A, {}, people.editor)).error).toMatch(/permission/i);
    expect((await as(people.editor, A, () => actions.setEmailEnabled(true))).ok).toBe(false);
    expect((await as(people.editor, A, () => actions.sendTestEmail())).ok).toBe(false);
    expect(await rawPrisma.emailSettings.count({ where: { projectId: A.id } })).toBe(0);
    expect(await rawPrisma.emailOutbox.count({ where: { projectId: A.id } })).toBe(0);
  });

  it("refuses everything in a project whose CLIENT_CENTER feature is off", async () => {
    expect((await save(C)).error).toBeTruthy();
    expect((await as(people.admin, C, () => actions.sendTestEmail())).ok).toBe(false);
    expect(await rawPrisma.emailSettings.count({ where: { projectId: C.id } })).toBe(0);
  });
});

describe("2. the password is write-only", () => {
  it("stores it encrypted, never returns it, and never echoes it with a refusal", async () => {
    expect((await save(A)).success).toBe(true);
    const row = await stored(A);
    expect(row.passwordCiphertext).toBeTruthy();
    expect(row.passwordCiphertext).not.toContain(GOOD.password);
    expect(decryptSecret(row.passwordCiphertext!)).toBe(GOOD.password);

    const v = await view(A);
    expect(JSON.stringify(v)).not.toContain(GOOD.password);
    expect(JSON.stringify(v)).not.toContain(row.passwordCiphertext!);
    expect(v.passwordSet).toBe(true);
    expect(Object.keys(v)).not.toContain("passwordCiphertext");

    const refused = await save(A, { port: "0" });
    expect(refused.error).toBeTruthy();
    expect(JSON.stringify(refused)).not.toContain(GOOD.password);
    expect(refused.values?.password).toBeUndefined();
  });

  it("keeps the stored password when the field is left blank, and replaces it when one is typed", async () => {
    const before = (await stored(A)).passwordCiphertext;
    expect((await save(A, { password: "" })).success).toBe(true);
    expect((await stored(A)).passwordCiphertext).toBe(before);
    expect((await save(A, { password: "new-secret" })).success).toBe(true);
    expect(decryptSecret((await stored(A)).passwordCiphertext!)).toBe("new-secret");
  });

  it("requires a password the first time", async () => {
    expect((await save(B, { password: "" })).error).toMatch(/password/i);
    expect(await rawPrisma.emailSettings.count({ where: { projectId: B.id } })).toBe(0);
  });

  it("writes no password and no host credential to the System Log", async () => {
    const logs = await rawPrisma.systemLog.findMany({ where: { projectId: A.id, scope: "email" } });
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toMatch(/secret|new-secret/);
  });
});

describe("3. validation", () => {
  it("refuses a bad host, a forbidden address, a bad sender and an inconsistent limit, naming each", async () => {
    for (const bad of [{ host: "https://smtp.example.test" }, { host: "127.0.0.1" }, { host: "169.254.169.254" }, { fromAddress: "not-an-address" }, { replyTo: "a@b" }, { maxPerMinute: "50", maxPerDay: "10" }, { tlsMode: "NONE" }] as Array<Record<string, string>>) {
      const r = await save(B, bad);
      expect(r.error, JSON.stringify(bad)).toBeTruthy();
    }
    expect(await rawPrisma.emailSettings.count({ where: { projectId: B.id } })).toBe(0);
  });
});

describe("4. connected only after a test under the settings as they are now", () => {
  it("walks from not tested to connected to needs-retest, and ignores changes that do not affect the connection", async () => {
    await save(B);
    expect((await view(B)).state).toBe("NOT_TESTED");
    await verify(B);
    expect((await view(B)).state).toBe("CONNECTED");

    // name, reply-to and limits do not change whether mail is accepted
    await save(B, { fromName: "Other name", replyTo: "reply@example.test", maxPerMinute: "20", password: "" });
    expect((await view(B)).state).toBe("CONNECTED");

    for (const change of [{ host: "smtp2.example.test" }, { port: "465", tlsMode: "TLS" }, { username: "other" }, { fromAddress: "billing@example.test" }, { password: "another-secret" }] as Array<Record<string, string>>) {
      await verify(B);
      expect((await view(B)).state, "before").toBe("CONNECTED");
      expect((await save(B, { password: "", ...change })).success).toBe(true);
      expect((await view(B)).state, JSON.stringify(Object.keys(change))).toBe("NEEDS_RETEST");
      await save(B, { host: "smtp.example.test", port: "587", tlsMode: "STARTTLS", username: "mailer", fromAddress: "support@example.test", password: GOOD.password });
      await verify(B);
    }
  });

  it("is not connected when the last test failed", async () => {
    await save(B);
    const s = await stored(B);
    await rawPrisma.emailSettings.update({ where: { id: s.id }, data: { verifiedVersion: null, lastTestOk: false, lastTestError: "The mail server refused the username or password." } });
    const v = await view(B);
    expect(v.state).toBe("TEST_FAILED");
    expect(v.lastTestError).toMatch(/refused/);
  });
});

describe("5. the test message", () => {
  it("is queued to the signed-in administrator's own address under the current settings, one at a time", async () => {
    await save(A);
    const settings = await stored(A);
    const r = await as(people.admin, A, () => actions.sendTestEmail());
    expect(r.ok).toBe(true);
    const rows = await rawPrisma.emailOutbox.findMany({ where: { projectId: A.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: "TEST", status: "QUEUED", toAddress: people.admin.email, settingsVersion: settings.settingsVersion, createdById: people.admin.userId });
    expect(rows[0]!.bodyText).not.toContain(GOOD.password);

    const again = await as(people.admin, A, () => actions.sendTestEmail());
    expect(again.ok).toBe(false);
    expect(await rawPrisma.emailOutbox.count({ where: { projectId: A.id } })).toBe(1);
  });

  it("refuses without complete settings, and when the login has no valid email address", async () => {
    expect((await as(people.admin, C, () => actions.sendTestEmail())).ok).toBe(false);
    const noMail = await user("Nomail", await role("EM nomail", ["communications.manage_email"]), `no-at-sign-${tag}`);
    await rawPrisma.projectAccess.createMany({ data: [{ projectId: B.id, userId: noMail.userId }], skipDuplicates: true });
    await save(B);
    const r = await as(noMail, B, () => actions.sendTestEmail());
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no valid email/i);
  });

  it("cannot be redirected to another address", async () => {
    await rawPrisma.emailOutbox.deleteMany({ where: { projectId: B.id } });
    await save(B);
    await as(people.admin, B, () => actions.sendTestEmail());
    const rows = await rawPrisma.emailOutbox.findMany({ where: { projectId: B.id } });
    expect(rows.map((x) => x.toAddress)).toEqual([people.admin.email]);
  });
});

describe("6. switching it on and off", () => {
  it("needs saved settings first, then toggles, with nothing sent", async () => {
    expect((await as(people.admin, C, () => actions.setEmailEnabled(true))).ok).toBe(false);
    expect((await as(people.admin, A, () => actions.setEmailEnabled(true))).ok).toBe(true);
    expect((await view(A)).enabled).toBe(true);
    expect((await as(people.admin, A, () => actions.setEmailEnabled(false))).ok).toBe(true);
    expect((await view(A)).enabled).toBe(false);
  });
});

describe("7. project isolation", () => {
  it("keeps each project's settings, credentials and queue to itself", async () => {
    await save(A, { host: "a.example.test", password: "pw-for-a" });
    await save(B, { host: "b.example.test", password: "pw-for-b" });
    expect((await view(A)).host).toBe("a.example.test");
    expect((await view(B)).host).toBe("b.example.test");
    expect(decryptSecret((await stored(A)).passwordCiphertext!)).toBe("pw-for-a");
    expect(decryptSecret((await stored(B)).passwordCiphertext!)).toBe("pw-for-b");
    expect((await as(people.admin, A, () => reads.listRecentEmails())).every((m) => m.toAddress === people.admin.email)).toBe(true);
    expect((await view(C)).exists).toBe(false);
  });

  it("makes the database refuse to move settings to another project", async () => {
    const s = await stored(A);
    await expect(rawPrisma.emailSettings.update({ where: { id: s.id }, data: { projectId: B.id } })).rejects.toThrow();
  });
});
