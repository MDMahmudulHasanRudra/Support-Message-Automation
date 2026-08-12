import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "node:crypto";

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
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
