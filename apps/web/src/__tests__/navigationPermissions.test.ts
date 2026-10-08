import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "@support-automation/shared";
import {
  NAV_GROUPS,
  navGroupsFor,
  navPermissionFor,
  REPORT_PAGES,
  REPORTS_LINK,
  reportPagesFor,
  SETTINGS_LINK,
  SETTINGS_SECTIONS,
  settingsSectionsFor,
  type NavGroup,
  type NavLink,
} from "@/app/p/[project]/(dashboard)/navigation";

/**
 * MULTI_PROJECT_PLAN.md §11, "Existing permissions": a role reaches exactly the same pages inside a
 * project as it did before projects existed. Checked the way the 27 Sep navigation change was — over
 * 323 role sets (every single key, all keys, none, 300 random) — by comparing today's
 * permission-filtered navigation with the pre-multi-project rule spelled out below.
 *
 * The rule is written inline ON PURPOSE, copied from the code as it was before Phases 4–5 touched
 * `navGroupsFor`: comparing the function with itself would prove nothing (see CLAUDE.md,
 * queryRewrites). With no project feature switched off — ISP Digital, and every new project by
 * default — the two must agree exactly, in every project.
 */

function legacyPermitted(href: string, granted: ReadonlySet<string>): boolean {
  const key = navPermissionFor(href);
  return key === null || granted.has(key);
}

function legacySettings(granted: ReadonlySet<string>) {
  return SETTINGS_SECTIONS.map((section) => ({ ...section, links: section.links.filter((l) => legacyPermitted(l.href, granted)) })).filter(
    (s) => s.links.length > 0,
  );
}

function legacyReports(granted: ReadonlySet<string>) {
  return REPORT_PAGES.filter((page) => legacyPermitted(page.href, granted));
}

function legacyNav(granted: ReadonlySet<string>): NavGroup[] {
  const firstSettingsPage = legacySettings(granted)[0]?.links[0] ?? null;
  const canOpenAnyReport = legacyReports(granted).length > 0;
  return NAV_GROUPS.map((group) => ({
    ...group,
    links: group.links.flatMap((link: NavLink) => {
      if (link === SETTINGS_LINK) return firstSettingsPage ? [{ ...SETTINGS_LINK, href: firstSettingsPage.href }] : [];
      if (link === REPORTS_LINK) return canOpenAnyReport ? [link] : [];
      if (link.tabs) {
        const tabs = link.tabs.filter((t) => legacyPermitted(t.href, granted));
        return tabs.length ? [{ ...link, href: tabs[0]!.href, tabs }] : [];
      }
      return legacyPermitted(link.href, granted) ? [link] : [];
    }),
  })).filter((group) => group.links.length > 0);
}

/** What a sidebar offers, as comparable data: group labels, link hrefs, tab hrefs. */
const shape = (groups: NavGroup[]) =>
  groups.map((g) => ({ group: g.label, links: g.links.map((l) => ({ href: l.href, tabs: l.tabs?.map((t) => t.href) ?? null })) }));

function roleSets(): Array<Set<string>> {
  const keys = PERMISSIONS.map((p) => p.key);
  const sets: Array<Set<string>> = [new Set(), new Set(keys), ...keys.map((k) => new Set([k]))];
  let seed = 20260929;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  while (sets.length < 2 + keys.length + 300) sets.push(new Set(keys.filter(() => random() < 0.4)));
  return sets;
}

describe("existing permissions are unchanged inside every project", () => {
  const sets = roleSets();

  it(`checks ${sets.length} role sets (every single key, all, none, 300 random)`, () => {
    expect(sets.length).toBe(2 + PERMISSIONS.length + 300);
  });

  it("the sidebar offers exactly the pages it offered before projects", () => {
    for (const granted of sets) expect(shape(navGroupsFor(granted, new Set()))).toEqual(shape(legacyNav(granted)));
  });

  it("the Settings rail and the Reports hub are unchanged too", () => {
    for (const granted of sets) {
      expect(settingsSectionsFor(granted, new Set()).map((s) => s.links.map((l) => l.href))).toEqual(
        legacySettings(granted).map((s) => s.links.map((l) => l.href)),
      );
      expect(reportPagesFor(granted, new Set()).map((p) => p.href)).toEqual(legacyReports(granted).map((p) => p.href));
    }
  });

  it("the Main Admin keys open nothing inside a project", () => {
    const all = new Set(PERMISSIONS.map((p) => p.key));
    const withoutMainAdmin = new Set([...all].filter((k) => !k.startsWith("projects.")));
    expect(shape(navGroupsFor(all, new Set()))).toEqual(shape(navGroupsFor(withoutMainAdmin, new Set())));
  });

  it("a switched-off feature only ever REMOVES pages — never adds one", () => {
    const off = new Set(["WHATSAPP_CHAT", "TEAM_MANAGEMENT", "BULK_MESSAGING"]);
    for (const granted of sets.slice(0, 60)) {
      const withFeatures = new Set(shape(navGroupsFor(granted, off)).flatMap((g) => g.links.map((l) => l.href)));
      const without = new Set(shape(legacyNav(granted)).flatMap((g) => g.links.map((l) => l.href)));
      // The one entry whose href can MOVE is Settings, which points at the first settings page left.
      const settingsPages = new Set(SETTINGS_SECTIONS.flatMap((s) => s.links.map((l) => l.href)));
      for (const href of withFeatures) expect(without.has(href) || settingsPages.has(href)).toBe(true);
      expect([...withFeatures].some((h) => h.startsWith("/chat") || h.startsWith("/team-management") || h.startsWith("/group-message-sender"))).toBe(false);
    }
  });
});
