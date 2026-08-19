import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "node:crypto";
import {
  PERMISSIONS,
  READ_ONLY_PERMISSION_KEYS,
  SUPPORT_MANAGER_PERMISSION_KEYS,
  SUPPORT_AGENT_PERMISSION_KEYS,
} from "@support-automation/shared";

const prisma = new PrismaClient();

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

  for (const member of exampleTeamMembers) {
    await prisma.internalTeamMember.upsert({
      where: { phoneNumber: member.phoneNumber },
      update: {},
      create: { ...member, status: "ACTIVE" },
    });
  }
  console.log(`Seeded ${exampleTeamMembers.length} example internal team members`);

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
    const existing = await prisma.automationRule.findFirst({ where: { name: rule.name } });
    if (existing) continue;
    await prisma.automationRule.create({
      data: {
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
  const existingGreeting = await prisma.automationRule.findFirst({ where: { name: greetingRuleName } });
  if (!existingGreeting) {
    await prisma.automationRule.create({
      data: {
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
      mode: "SAFE_AUTO_REPLY",
      automationEnabled: true,
    },
  });
  console.log("Seeded safe default automation settings (SAFE_AUTO_REPLY)");

  await prisma.groupBroadcastSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });
  console.log("Seeded conservative default Group Message Sender settings");

  await prisma.securitySettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });
  console.log("Seeded default Security Settings (24h session lifetime)");

  // Permission catalogue is code-defined at packages/shared/src/permissions.ts — synced here
  // (never created ad hoc from the UI), so a key's label/category can be corrected in code and
  // will update on the next seed run without touching PermissionModule assignments.
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: p.key },
      update: { label: p.label, category: p.category },
      create: { key: p.key, label: p.label, category: p.category },
    });
  }
  console.log(`Synced ${PERMISSIONS.length} permissions`);

  const allPermissionKeys = PERMISSIONS.map((p) => p.key);
  const defaultModules: Array<{ name: string; description: string; keys: readonly string[] }> = [
    { name: "Administrator", description: "Full access to every module.", keys: allPermissionKeys },
    {
      name: "Support Manager",
      description: "Manages automation rules and views App Users.",
      keys: SUPPORT_MANAGER_PERMISSION_KEYS,
    },
    {
      name: "Support Agent",
      description: "Creates and edits automation rules.",
      keys: SUPPORT_AGENT_PERMISSION_KEYS,
    },
    { name: "Read Only", description: "View-only access across every module.", keys: READ_ONLY_PERMISSION_KEYS },
  ];

  const administratorModuleId: { current?: string } = {};
  for (const mod of defaultModules) {
    // Only sets isSystem on first creation; permissions are re-synced every run so the defaults
    // stay current as new permission keys are added, matching the "code is the source of truth"
    // rule stated above — but the module's own name/isSystem never gets silently overwritten.
    const permissionRows = await prisma.permission.findMany({ where: { key: { in: [...mod.keys] } }, select: { id: true } });
    const permissionModule = await prisma.permissionModule.upsert({
      where: { name: mod.name },
      update: {},
      create: { name: mod.name, description: mod.description, isSystem: true },
    });
    await prisma.permissionModulePermission.deleteMany({ where: { permissionModuleId: permissionModule.id } });
    await prisma.permissionModulePermission.createMany({
      data: permissionRows.map((p) => ({ permissionModuleId: permissionModule.id, permissionId: p.id })),
    });
    if (mod.name === "Administrator") administratorModuleId.current = permissionModule.id;
  }
  console.log(`Seeded ${defaultModules.length} default Permission Modules`);

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
