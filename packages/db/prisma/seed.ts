import { PrismaClient } from "@prisma/client";
import { ensureDefaultRoles } from "../src/index";
import { randomBytes, scryptSync } from "node:crypto";
import {
  DEFAULT_SHIFT_TEMPLATES,
  PERMISSIONS,
} from "@support-automation/shared";

const prisma = new PrismaClient();

/**
 * Everything project-scoped this script creates belongs to ISP Digital, the original installation
 * (MULTI_PROJECT_PLAN.md). Named explicitly on every write: since Phase 3 the database has no
 * default project, so a row that does not name one is refused.
 */
const ISP_DIGITAL = "proj_isp_digital";

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

async function main() {
  const adminUsername = process.env.SEED_ADMIN_USERNAME ?? "admin";
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@example.com";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";

  // Only sets credentials on first creation, same as every other seed step below — an admin who
  // has since changed their password through the dashboard must never have it silently reset back
  // to the .env value by a routine restart/redeploy re-running this script.
  const admin = await prisma.user.upsert({
    where: { username: adminUsername },
    update: {},
    create: {
      username: adminUsername,
      email: adminEmail,
      name: "Administrator",
      passwordHash: hashPassword(adminPassword),
    },
  });
  console.log(`Seeded admin user: ${admin.username}`);

  // Multi-project (MULTI_PROJECT_PLAN.md): the original installation's project (id
  // proj_isp_digital) is created by the 20260928150000_projects_foundation migration, and a fresh
  // install names it "Nexora Project 1" (20261021090000_nexora_white_label_defaults); an existing
  // install keeps its name (ISP Digital on the original one). On a fresh install the seeded
  // admin is created AFTER that migration ran, so it would have no project access — give it access
  // to ISP Digital. Access only: what the admin may do is still its existing role, set below.
  // Idempotent, and never removes anyone's access.
  await prisma.project.upsert({
    where: { id: ISP_DIGITAL },
    update: {},
    create: { id: ISP_DIGITAL, name: "Nexora Project 1", slug: "nexora-project-1", status: "ACTIVE" },
  });
  await prisma.projectAccess.upsert({
    where: { projectId_userId: { projectId: "proj_isp_digital", userId: admin.id } },
    update: {},
    create: { projectId: "proj_isp_digital", userId: admin.id },
  });

  const exampleTeamMembers = [
    {
      name: "Support Executive 1",
      phoneNumber: "+8801700000001",
      role: "Support",
      department: "Customer Support",
    },
    {
      name: "Support Executive 2",
      phoneNumber: "+8801700000002",
      role: "Support",
      department: "Customer Support",
    },
  ] as const;

  // Examples exist so a fresh install has something to look at, and only then. Upserting them by
  // phone number meant any admin who deleted them got them back on the next redeploy, because
  // every `docker compose up` re-runs this script: two fake "Support Executive" rows reappeared in
  // a live roster the day Team Management shipped, where they would sit in schedules, attendance
  // and duty planning as if they were staff. An empty roster is the only one that gets them.
  const existingTeamMembers = await prisma.internalTeamMember.count({ where: { projectId: ISP_DIGITAL } });
  if (existingTeamMembers === 0) {
    for (const member of exampleTeamMembers) {
      await prisma.internalTeamMember.upsert({
        where: { projectId_phoneNumber: { projectId: ISP_DIGITAL, phoneNumber: member.phoneNumber } },
        update: {},
        create: { ...member, status: "ACTIVE", projectId: ISP_DIGITAL },
      });
    }
    console.log(`Seeded ${exampleTeamMembers.length} example internal team members`);
  } else {
    console.log(`Skipped example team members: the roster already has ${existingTeamMembers}`);
  }

  const defaultIgnoreRules: Array<{
    name: string;
    matchType: "EXACT" | "CONTAINS";
    matchValue: string;
  }> = [
    { name: "Ignore: Payment successful", matchType: "CONTAINS", matchValue: "payment successful" },
    { name: "Ignore: Recharge successful", matchType: "CONTAINS", matchValue: "recharge successful" },
    { name: "Ignore: Bangla payment confirmation", matchType: "CONTAINS", matchValue: "আপনার পেমেন্ট সফলভাবে গ্রহণ করা হয়েছে" },
  ];

  for (const rule of defaultIgnoreRules) {
    const existing = await prisma.automationRule.findFirst({ where: { projectId: ISP_DIGITAL, name: rule.name } });
    if (existing) continue;
    await prisma.automationRule.create({
      data: {
        projectId: ISP_DIGITAL,
        name: rule.name,
        description: "Seeded default-ignore rule for a known system/confirmation message.",
        type: "DEFAULT_IGNORE",
        matchType: rule.matchType,
        matchValue: rule.matchValue,
        conditions: {},
        actions: [{ type: "IGNORE" }],
        priority: 10,
        status: "ACTIVE",
      },
    });
  }
  console.log(`Seeded ${defaultIgnoreRules.length} default-ignore rules`);

  const greetingRuleName = "Auto Reply: Greeting";
  const existingGreeting = await prisma.automationRule.findFirst({ where: { projectId: ISP_DIGITAL, name: greetingRuleName } });
  if (!existingGreeting) {
    await prisma.automationRule.create({
      data: {
        projectId: ISP_DIGITAL,
        name: greetingRuleName,
        description: "Seeded example SAFE_AUTO_REPLY acknowledgement for a plain greeting.",
        type: "AUTO_REPLY",
        matchType: "KEYWORDS",
        keywords: ["হ্যালো", "hello", "hi"],
        conditions: {},
        actions: [{ type: "AUTO_REPLY" }],
        priority: 70,
        status: "ACTIVE",
        cooldownSeconds: 43_200, // 12 hours
        replyMessage:
          "আসসালামু আলাইকুম। আমাদের Support Team-এ যোগাযোগ করার জন্য ধন্যবাদ। অনুগ্রহ করে আপনার সমস্যাটি বিস্তারিত লিখুন।",
        replyDelayMinMs: 3000,
        replyDelayMaxMs: 15000,
      },
    });
  }
  console.log("Seeded example auto-reply rule");

  await prisma.automationSettings.upsert({
    where: { id: "global" },
    update: {},
    create: {
      id: "global",
      projectId: ISP_DIGITAL,
      mode: "SAFE_AUTO_REPLY",
      automationEnabled: true,
    },
  });
  console.log("Seeded safe default automation settings (SAFE_AUTO_REPLY)");

  await prisma.groupBroadcastSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global", projectId: ISP_DIGITAL },
  });
  console.log("Seeded conservative default Group Message Sender settings");

  await prisma.securitySettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });
  console.log("Seeded default Security Settings (24h session lifetime)");

  // The shifts this office runs today. SEED DATA, never a business rule: nothing in the codebase
  // may branch on the name "Morning" or on 10:00-19:00, because the whole point of ShiftTemplate
  // is that an operator can add a night shift or a 09:00-18:00 from the UI without a code change.
  //
  // `update: {}` so re-seeding never overwrites times somebody has since corrected — the same
  // create-once discipline the default Permission Modules below use for `isSystem`. Minutes are
  // measured from local midnight.
  // Shared with project creation (packages/shared/src/projects.ts), so a new project starts with
  // exactly the shifts ISP Digital was given.
  const DEFAULT_SHIFTS = DEFAULT_SHIFT_TEMPLATES;
  for (const shift of DEFAULT_SHIFTS) {
    await prisma.shiftTemplate.upsert({
      where: { projectId_name: { projectId: ISP_DIGITAL, name: shift.name } },
      update: {},
      create: { ...shift, projectId: ISP_DIGITAL },
    });
  }
  console.log(`Seeded ${DEFAULT_SHIFTS.length} default shift templates`);

  // Permission catalogue is code-defined at packages/shared/src/permissions.ts — synced here
  // (never created ad hoc from the UI), so a key's label/category can be corrected in code and
  // will update on the next seed run without touching PermissionModule assignments.
  // Which keys exist before this run, so a key genuinely NEW in this deploy can be offered to the
  // default roles that should have it (below) without re-deciding the keys they already have.
  const keysBefore = new Set((await prisma.permission.findMany({ select: { key: true } })).map((p) => p.key));
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: p.key },
      update: { label: p.label, category: p.category },
      create: { key: p.key, label: p.label, category: p.category },
    });
  }
  console.log(`Synced ${PERMISSIONS.length} permissions`);

  // Keys whose feature was removed. Named one by one rather than "anything not in the catalogue":
  // a blanket delete would wipe a NEWER deploy's keys if an older seed ever ran during a rollback.
  // Their role assignments go with them (the join table cascades).
  const RETIRED_PERMISSION_KEYS = [
    // Microsoft Teams Integration, removed 27 Sep 2026.
    "teams_integration.view",
    "teams_integration.manage",
  ];
  const retired = await prisma.permission.deleteMany({ where: { key: { in: RETIRED_PERMISSION_KEYS } } });
  if (retired.count > 0) console.log(`Removed ${retired.count} retired permission(s)`);

  const allPermissionKeys = PERMISSIONS.map((p) => p.key);
  const keysCreatedNow = new Set(allPermissionKeys.filter((key) => !keysBefore.has(key)));
  // The standard roles, ADD-ONLY (PROJECT_ROLES.md, audit finding 2; see ensureDefaultRoles): for the
  // original installation, and for every later customer so a new key reaches each customer's
  // Administrator too (SAAS_PLATFORM_PLAN.md §12). Nothing is ever removed.
  const administratorModuleId: { current?: string } = {};
  administratorModuleId.current = (await ensureDefaultRoles(prisma, null, keysCreatedNow)).administratorId;
  const customers = await prisma.customer.findMany({ where: { isFounding: false }, select: { id: true } });
  for (const customer of customers) await ensureDefaultRoles(prisma, customer.id, keysCreatedNow);
  console.log(`Synced the default roles of the original installation and ${customers.length} customer(s)`);

  // The pre-existing seeded admin predates the permission system — give it Administrator so
  // nothing about that login changes, without ever overwriting a module an operator already
  // assigned by hand (only fills in when null).
  if (administratorModuleId.current && !admin.permissionModuleId) {
    await prisma.user.update({ where: { id: admin.id }, data: { permissionModuleId: administratorModuleId.current } });
    console.log(`Assigned "${admin.username}" to the Administrator Permission Module`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
