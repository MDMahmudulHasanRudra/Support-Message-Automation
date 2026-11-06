import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROJECT_SCOPED_MODELS } from "@support-automation/db";

/**
 * Every table with a required `projectId` must be in PROJECT_SCOPED_MODELS. A table left out gets no automatic
 * project filter, and nothing else notices: a query that reads as "this project's reopen policy" returns another
 * project's row. That shipped once, for the three Inbox V3 tables and FailedReplyAction. A new table must either be
 * listed or be named below with the reason it is read outside a project.
 */
const READ_OUTSIDE_A_PROJECT: Record<string, string> = {
  ProjectAccess: "who may enter a project: read before any project is chosen",
  ProjectFeature: "a project's entitlements: read by the feature resolver with the platform client",
  UserInvitation: "accepted on a public page, before the invited person has a session",
};

const schema = readFileSync(fileURLToPath(new URL("../../../../packages/db/prisma/schema.prisma", import.meta.url)), "utf8");
const projectOwned = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].filter((m) => /^\s+projectId\s+String\s/m.test(m[2]!)).map((m) => m[1]!);

describe("project-scoped client", () => {
  it("finds the project-owned tables in the schema", () => {
    expect(projectOwned.length).toBeGreaterThan(100);
  });

  it("covers every table with a required projectId", () => {
    expect(projectOwned.filter((name) => !PROJECT_SCOPED_MODELS.has(name) && !READ_OUTSIDE_A_PROJECT[name])).toEqual([]);
  });

  it("the exceptions are real tables, not leftovers", () => {
    for (const name of Object.keys(READ_OUTSIDE_A_PROJECT)) expect(projectOwned).toContain(name);
  });
});
