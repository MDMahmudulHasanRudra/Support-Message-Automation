import { describe, expect, it } from "vitest";
import { CHANNEL_TYPES, INBOX_SCOPES, inboxScopeLabel, LEGACY_WHATSAPP_LABEL, PROJECT_FEATURES, PERMISSIONS } from "@support-automation/shared";
import { NAV_GROUPS, SETTINGS_SECTIONS } from "@/app/p/[project]/(dashboard)/navigation";
import { ACCESS_MODULES } from "@/app/p/[project]/(dashboard)/projectSections";
import { CHANNEL_PRESENTATION } from "@/app/p/[project]/(dashboard)/conversations/ChannelMark";

/**
 * Meta expansion A1 (docs/meta-expansion/09): the OpenWA channel is SHOWN as "WhatsApp (Legacy)", so it can
 * never be confused with "WhatsApp (Official API)". Only words on screen change. Every route, permission key,
 * feature key, inbox scope, section id and module id below is pinned to its value before the rename: a
 * project role's saved page access, a bookmark, a report link or a stored preference must mean exactly what
 * it meant before.
 */

const WHATSAPP_GROUP_HREFS = ["/accounts", "/groups", "/team-members", "/teams", "/group-message-sender", "/group-member-adder", "/group-admin-maker"];

describe("A1 — WhatsApp (Legacy) is a label, not an identifier", () => {
  it("the label is the one shared constant", () => {
    expect(LEGACY_WHATSAPP_LABEL).toBe("WhatsApp (Legacy)");
  });

  it("the sidebar module is labelled Legacy, keeps its id and every page it held", () => {
    const group = NAV_GROUPS.find((g) => g.id === "whatsapp");
    expect(group?.label).toBe(LEGACY_WHATSAPP_LABEL);
    expect(group!.links.map((l) => l.href)).toEqual(WHATSAPP_GROUP_HREFS);
    expect(NAV_GROUPS.filter((g) => g.label === "WhatsApp")).toEqual([]);
  });

  it("the Settings section is labelled Legacy and keeps its pages", () => {
    const section = SETTINGS_SECTIONS.find((s) => s.label === LEGACY_WHATSAPP_LABEL);
    expect(section?.links.map((l) => l.href)).toEqual(["/accounts/routing", "/settings/media-storage"]);
  });

  it("project-role page access keeps the module id `whatsapp` and the same section ids", () => {
    const whatsapp = ACCESS_MODULES.find((m) => m.id === "whatsapp");
    expect(whatsapp?.label).toBe(LEGACY_WHATSAPP_LABEL);
    const ids = whatsapp!.groups.flatMap((g) => g.entries.flatMap((e) => e.sections.map((s) => s.id)));
    expect(ids).toEqual(expect.arrayContaining(["/accounts", "/groups", "/team-members", "/teams", "/group-message-sender", "/group-member-adder", "/group-admin-maker"]));
    expect(ACCESS_MODULES.some((m) => m.id === "whatsapp-legacy")).toBe(false);
  });

  it("All Conversations: the scope is still `whatsapp`, shown as Legacy", () => {
    expect(INBOX_SCOPES).toContain("whatsapp");
    expect(inboxScopeLabel("whatsapp")).toBe(LEGACY_WHATSAPP_LABEL);
    expect(CHANNEL_PRESENTATION.WHATSAPP.label).toBe(LEGACY_WHATSAPP_LABEL);
  });

  it("no identifier moved: WhatsApp is still not a channel type, and the keys are unchanged", () => {
    expect([...CHANNEL_TYPES]).toEqual(["MESSENGER", "INSTAGRAM", "TELEGRAM", "WEBCHAT"]);
    const chat = PROJECT_FEATURES.find((f) => f.key === "WHATSAPP_CHAT");
    expect(chat).toMatchObject({ label: "WhatsApp Chat", routes: ["/chat"], permissionKeys: ["messages.reply"] });
    expect(PERMISSIONS.filter((p) => p.key.startsWith("whatsapp.")).map((p) => p.key)).toEqual(["whatsapp.view", "whatsapp.manage"]);
  });
});
