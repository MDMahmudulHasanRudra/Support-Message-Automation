import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Contacts (CONTACTS.md): a number is held once per project, a project never sees another's contacts, a client is never
 * changed, and someone who said no to offers is never in a campaign.
 */

let current: Session | null;
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => {
    if (!current) throw new Error("NEXT_REDIRECT /login");
    return current;
  },
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => p, inWorkspace: async () => false }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(activeHeaders),
  cookies: async () => ({ get: () => undefined }),
}));
const activeHeaders: Record<string, string> = {};

const { runWithProject } = await import("@/server/projectContext");
const actions = await import("@/server/actions/contacts");
const server = await import("@/server/contacts");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const fx = {} as { a: { id: string; slug: string; name: string; status: "ACTIVE" }; b: { id: string; slug: string; name: string; status: "ACTIVE" }; full: Session; viewer: Session; roles: string[]; users: string[] };

async function role(name: string, keys: string[]) {
  const permissions = await Promise.all(
    keys.map((key) => {
      const def = PERMISSIONS.find((p) => p.key === key)!;
      return rawPrisma.permission.upsert({ where: { key }, create: { key, label: def.label, category: def.category }, update: {}, select: { id: true } });
    }),
  );
  const r = await rawPrisma.permissionModule.create({ data: { name: `${name} ${tag}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
  fx.roles.push(r.id);
  return r.id;
}
async function user(name: string, roleId: string) {
  const u = await rawPrisma.user.create({ data: { username: `${name}_${tag}`, email: `${name}_${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId } });
  for (const projectId of [fx.a.id, fx.b.id]) await rawPrisma.projectAccess.create({ data: { projectId, userId: u.id } });
  fx.users.push(u.id);
  return { userId: u.id, username: u.username, email: u.email!, name, tenant: null } as unknown as Session;
}
const inA = <T,>(fn: () => Promise<T>) => runWithProject(fx.a as never, fn);
const inB = <T,>(fn: () => Promise<T>) => runWithProject(fx.b as never, fn);
const phone = () => `01${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const ok = <T,>(r: T | { error: string }) => {
  if (r && typeof r === "object" && "error" in r) throw new Error(String((r as { error: string }).error));
  return r as T;
};

beforeAll(async () => {
  Object.assign(fx, { roles: [], users: [] });
  const make = async (n: string) => {
    const p = await createProjectWithDefaults({ name: `${n} ${tag}`, slug: `${n}-${tag}`, status: "ACTIVE", creatorUserId: null }, rawPrisma);
    return { id: p.id, slug: p.slug, name: n, status: "ACTIVE" as const };
  };
  fx.a = await make("ca");
  fx.b = await make("cb");
  for (const projectId of [fx.a.id, fx.b.id]) await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId, key: "CLIENT_CENTER" } }, create: { projectId, key: "CLIENT_CENTER", enabled: true }, update: { enabled: true } });
  forgetProjectFeatureStates();
  const all = await role("C all", ["contacts.view", "contacts.edit", "contacts.delete", "contacts.import", "contacts.export", "contacts.campaign", "clients.view", "settings.view", "settings.edit"]);
  const read = await role("C read", ["contacts.view"]);
  fx.full = await user("c_full", all);
  fx.viewer = await user("c_view", read);
});

beforeEach(() => {
  current = fx.full;
});

afterAll(async () => {
  const tables = (await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`).map((t) => t.table_name);
  for (const id of [fx.a.id, fx.b.id]) {
    for (let pass = 0; pass < 4; pass++) for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, id).catch(() => undefined);
    await rawPrisma.project.deleteMany({ where: { id } });
  }
  await rawPrisma.user.deleteMany({ where: { id: { in: fx.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: fx.roles } } });
});

describe("the same number is never saved twice", () => {
  it("refuses a second contact with a number already on one, naming whose it is", async () => {
    const number = phone();
    await inA(() => actions.createContact({ name: "First", values: [{ kind: "PHONE", value: number }] }));
    const second = await inA(() => actions.createContact({ name: "Second", values: [{ kind: "PHONE", value: `+88${number}` }] }));
    expect(second).toEqual({ error: expect.stringContaining("First") });
  });

  it("the database refuses it even if the code forgets", async () => {
    const r = ok(await inA(() => actions.createContact({ name: "Held" })));
    const row = { projectId: fx.a.id, contactId: r.id, kind: "EMAIL" as const, value: "dup@example.test", normalized: `dup-${tag}@example.test` };
    await rawPrisma.contactIdentifier.create({ data: row });
    await expect(rawPrisma.contactIdentifier.create({ data: row })).rejects.toThrow();
  });

  it("two people adding at once get different serial numbers", async () => {
    const made = await Promise.all(Array.from({ length: 8 }, (_, i) => inA(() => actions.createContact({ name: `Race ${i}` }))));
    const labels = made.map((m) => ok(m).label);
    expect(new Set(labels).size).toBe(8);
  });

  it("serial numbers are counted per project", async () => {
    const before = ok(await inB(() => actions.createContact({ name: "B one" })));
    const after = ok(await inB(() => actions.createContact({ name: "B two" })));
    expect(Number(after.label.slice(3))).toBe(Number(before.label.slice(3)) + 1);
  });
});

describe("between projects", () => {
  it("another project's contact is simply not found", async () => {
    const r = ok(await inA(() => actions.createContact({ name: "Private A" })));
    await expect(inB(() => actions.updateContact(r.id, { name: "Stolen" }))).resolves.toEqual({ error: expect.any(String) });
    expect((await rawPrisma.contact.findUniqueOrThrow({ where: { id: r.id } })).name).toBe("Private A");
    const list = await inB(() => server.listContacts(server.readContactFilters({ q: "Private A" }), 1, 50));
    expect(list.total).toBe(0);
  });

  it("the same number can exist in two projects", async () => {
    const number = phone();
    ok(await inA(() => actions.createContact({ name: "In A", values: [{ kind: "PHONE", value: number }] })));
    ok(await inB(() => actions.createContact({ name: "In B", values: [{ kind: "PHONE", value: number }] })));
  });

  it("a contact cannot point at another project's client", async () => {
    const client = await rawPrisma.client.create({ data: { projectId: fx.b.id, code: `C-${tag}`, name: "B client" } });
    const r = ok(await inA(() => actions.createContact({ name: "Linker" })));
    expect(await inA(() => actions.linkContactToClient(r.id, client.id))).toEqual({ error: expect.stringContaining("not in this project") });
    await expect(rawPrisma.contact.update({ where: { id: r.id }, data: { linkedClientId: client.id } })).rejects.toThrow();
  });
});

describe("permissions", () => {
  it("a read-only person cannot add, export a campaign or import", async () => {
    current = fx.viewer;
    expect(await inA(() => actions.createContact({ name: "Nope" }))).toEqual({ error: expect.any(String) });
    expect(await inA(() => actions.bulkUpdateContacts({ ids: ["x"] }, { op: "archive" }))).toEqual({ error: expect.any(String) });
    expect(await inA(() => actions.createContactCampaign({ name: "x", channel: "EMAIL", subject: "s", body: "b", includeUnknown: true, selection: { ids: [] } }))).toEqual({ error: expect.any(String) });
  });
});

describe("Clients stay untouched", () => {
  it("copying the client list reads clients, links them and changes nothing on them", async () => {
    const number = phone();
    const client = await rawPrisma.client.create({ data: { projectId: fx.a.id, code: `L-${tag}`, name: "Listed client", channels: { create: { projectId: fx.a.id, kind: "WHATSAPP", value: number, normalizedValue: `88${number}` } } } });
    const before = await rawPrisma.client.findUniqueOrThrow({ where: { id: client.id } });
    const first = ok(await inA(() => actions.importFromClientList()));
    expect(first.created).toBeGreaterThanOrEqual(1);
    const contact = await rawPrisma.contact.findFirstOrThrow({ where: { projectId: fx.a.id, linkedClientId: client.id }, include: { identifiers: true } });
    expect(contact.source).toBe("CLIENT_LIST");
    expect(contact.code).toBeNull();
    expect(contact.identifiers[0]).toMatchObject({ kind: "PHONE", normalized: `88${number}`, isWhatsApp: true });
    expect(await rawPrisma.client.findUniqueOrThrow({ where: { id: client.id } })).toEqual(before);

    const again = ok(await inA(() => actions.importFromClientList()));
    expect(again.created).toBe(0);
  });
});

describe("importing", () => {
  it("fills only blanks on a known contact and shares one contact between rows with one number", async () => {
    const number = phone();
    const existing = ok(await inA(() => actions.createContact({ name: "Keeps Name", values: [{ kind: "PHONE", value: number }] })));
    const shared = phone();
    const fields = (name: string, company: string, p: string) => ({ line: 2, fields: { name, code: null, company, jobTitle: null, address: null, city: null, country: null, mapUrl: null, latitude: null, longitude: null, birthday: null, notes: null, tags: [] }, consent: null, identifiers: [{ kind: "PHONE" as const, value: `+88${p}`, normalized: `88${p}`, isWhatsApp: false }], problems: [] });
    const result = await inA(() =>
      server.saveContactImportRows([fields("Overwrites", "Filled Co", number), fields("Twin one", "", shared), fields("Twin two", "", shared)], { source: "IMPORT", sourceDetail: "t.csv", actor: { userId: fx.full.userId, name: "x" } }),
    );
    expect(result.created).toBe(1);
    expect(await rawPrisma.contact.findUniqueOrThrow({ where: { id: existing.id } })).toMatchObject({ name: "Keeps Name", company: "Filled Co" });
    expect(await rawPrisma.contactIdentifier.count({ where: { projectId: fx.a.id, normalized: `88${shared}` } })).toBe(1);
  });
});

describe("merging", () => {
  it("moves numbers and chats, keeps the target's own details, and a No stays a No", async () => {
    const a = ok(await inA(() => actions.createContact({ name: "Keep", values: [{ kind: "PHONE", value: phone() }] })));
    const b = ok(await inA(() => actions.createContact({ name: "Goes", company: "From B", values: [{ kind: "PHONE", value: phone() }] })));
    await inA(() => actions.setContactConsent(b.id, "OPTED_OUT"));
    ok(await inA(() => actions.mergeContacts(b.id, a.id)));
    const kept = await rawPrisma.contact.findUniqueOrThrow({ where: { id: a.id }, include: { identifiers: true } });
    expect(kept).toMatchObject({ name: "Keep", company: "From B", consent: "OPTED_OUT" });
    expect(kept.identifiers).toHaveLength(2);
    expect(await rawPrisma.contact.count({ where: { id: b.id } })).toBe(0);
  });
});

describe("campaigns", () => {
  async function person(name: string, consent: "UNKNOWN" | "OPTED_IN" | "OPTED_OUT", email: boolean) {
    const r = ok(await inA(() => actions.createContact({ name, values: email ? [{ kind: "EMAIL", value: `${name.toLowerCase()}-${tag}@example.test` }] : [{ kind: "PHONE", value: phone() }] })));
    await inA(() => actions.setContactConsent(r.id, consent));
    return r.id;
  }

  it("someone who said no is never included, whatever is ticked", async () => {
    const no = await person("Refused", "OPTED_OUT", true);
    const yes = await person("Agreed", "OPTED_IN", true);
    const unknown = await person("Unasked", "UNKNOWN", true);
    const none = await person("Nomail", "OPTED_IN", false);
    const audience = await inA(() => server.readCampaignAudience({ ids: [no, yes, unknown, none] }, "EMAIL", true));
    const by = new Map(audience.map((a) => [a.contactId, a.skipReason]));
    expect(by.get(no)).toBe("Said no to offers");
    expect(by.get(yes)).toBeNull();
    expect(by.get(unknown)).toBeNull();
    expect(by.get(none)).toContain("email");
    const strict = await inA(() => server.readCampaignAudience({ ids: [unknown] }, "EMAIL", false));
    expect(strict[0]!.skipReason).toBe("Has not agreed to offers");
  });

  it("starting twice queues each email once", async () => {
    const id = await person("Once", "OPTED_IN", true);
    await rawPrisma.emailSettings.create({ data: { projectId: fx.a.id, enabled: true, host: "smtp.example.test", fromAddress: "a@example.test", passwordCiphertext: "x", settingsVersion: 1, verifiedVersion: 1 } as never });
    const c = ok(await inA(() => actions.createContactCampaign({ name: "Promo", channel: "EMAIL", subject: "Hi", body: "Hello {{name}}", includeUnknown: false, selection: { ids: [id] } })));
    const [one, two] = await Promise.all([inA(() => actions.startContactCampaign(c.id)), inA(() => actions.startContactCampaign(c.id))]);
    expect([one, two].filter((r) => !("error" in r))).toHaveLength(1);
    const rows = await rawPrisma.emailOutbox.findMany({ where: { projectId: fx.a.id, purpose: "CONTACT_CAMPAIGN", idempotencyKey: { contains: c.id } } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bodyText).toContain("Hello Once");
    expect(rows[0]!.bodyText).toContain("Reply STOP");
    expect((await rawPrisma.contactCampaignRecipient.findFirstOrThrow({ where: { campaignId: c.id } })).status).toBe("QUEUED");
  });

  it("a WhatsApp campaign sends nothing by itself", async () => {
    const id = await person("Worklist", "OPTED_IN", false);
    const before = await rawPrisma.outboundMessage.count({ where: { projectId: fx.a.id } });
    const c = ok(await inA(() => actions.createContactCampaign({ name: "Wake", channel: "WHATSAPP", subject: "", body: "Hello", includeUnknown: false, selection: { ids: [id] } })));
    ok(await inA(() => actions.startContactCampaign(c.id)));
    expect(await rawPrisma.outboundMessage.count({ where: { projectId: fx.a.id } })).toBe(before);
    const row = await rawPrisma.contactCampaignRecipient.findFirstOrThrow({ where: { campaignId: c.id } });
    ok(await inA(() => actions.markCampaignRecipient(row.id, "DONE")));
    expect((await rawPrisma.contact.findUniqueOrThrow({ where: { id } })).lastContactedAt).not.toBeNull();
  });
});
