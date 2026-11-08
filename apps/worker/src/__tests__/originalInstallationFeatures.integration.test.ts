import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults } from "@support-automation/db";
import { withProject } from "../project/context.js";
import { projectCustomerKey, projectHasFeature, resetProjectFeatureCacheForTests } from "../project/features.js";
import { ISP_DIGITAL, rawPrisma } from "./helpers/projectFixtures.js";

/**
 * Forge reads the software owner's private repositories with the installation's own key, so the sync, the research and
 * the live answer (all behind projectHasFeature) never run for a customer, whatever its switches say.
 */
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const fx = {} as { customer: string; project: string };

beforeAll(async () => {
  const customer = await rawPrisma.customer.create({ data: { name: `forge ${tag}` } });
  const project = await createProjectWithDefaults({ name: `forge ${tag}`, slug: `forge-${tag}`, status: "ACTIVE", creatorUserId: null, customerId: customer.id }, rawPrisma);
  fx.customer = customer.id;
  fx.project = project.id;
  await rawPrisma.projectFeature.upsert({
    where: { projectId_key: { projectId: project.id, key: "PRODUCT_KNOWLEDGE_FORGE" } },
    update: { enabled: true },
    create: { projectId: project.id, key: "PRODUCT_KNOWLEDGE_FORGE", enabled: true },
  });
});

beforeEach(() => resetProjectFeatureCacheForTests());
afterAll(() => resetProjectFeatureCacheForTests());

describe("features of the original installation only", () => {
  it("Forge never runs for a customer, even switched on", async () => {
    expect(await withProject(fx.project, () => projectHasFeature("PRODUCT_KNOWLEDGE_FORGE"))).toBe(false);
  });

  it("Forge still runs in the original installation", async () => {
    expect(await withProject(ISP_DIGITAL, () => projectHasFeature("PRODUCT_KNOWLEDGE_FORGE"))).toBe(true);
  });

  it("every other module of a customer follows its own switch", async () => {
    expect(await withProject(fx.project, () => projectHasFeature("SUPPORT_ACTIVITY" as never))).toBe(true);
  });

  it("names the customer a per-customer record is stored under", async () => {
    expect(await withProject(fx.project, () => projectCustomerKey())).toBe(fx.customer);
    expect(await withProject(ISP_DIGITAL, () => projectCustomerKey())).toBe("");
  });
});
