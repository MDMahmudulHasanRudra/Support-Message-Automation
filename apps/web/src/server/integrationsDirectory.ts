import "server-only";
import { pathAllowedByFeatures, type ProjectFeatureKey } from "@support-automation/shared";
import { prisma } from "@/server/db";
import type { Session } from "@/server/auth";
import { getGrantedPermissionKeys, getPageAccess } from "@/server/permissions";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { requireActiveProject } from "@/server/projectContext";
import { navPermissionFor } from "@/app/p/[project]/(dashboard)/navigation";
import { canOpenPath } from "@/app/p/[project]/(dashboard)/projectSections";

/**
 * Every integration a project can have, in one place (Integrations page). Nothing here sets anything up: each
 * card points at the integration's own page, which keeps its own checks and forms. This file only decides which
 * cards a person may see (the same rules as the sidebar: their key, the project's modules, their page access)
 * and reads each one's REAL state from its own records, inside the active project.
 */

export type IntegrationCategory = "Messaging" | "Selling & delivery" | "Tools & AI" | "Developers";
export const INTEGRATION_CATEGORIES: readonly IntegrationCategory[] = ["Messaging", "Selling & delivery", "Tools & AI", "Developers"];

export type IntegrationIcon =
  | "whatsapp" | "messenger" | "instagram" | "telegram" | "webchat" | "email" | "commerce" | "woocommerce" | "shopify"
  | "courier" | "payments" | "sheets" | "ai" | "knowledge" | "social" | "api";

export type IntegrationState =
  /** At least one connection is working. */
  | "CONNECTED"
  /** Something was set up but is not working: the page says why. */
  | "ATTENTION"
  /** Nothing set up yet. */
  | "NOT_SET_UP"
  /** The project's module for it is switched off by a Main Admin. */
  | "MODULE_OFF";

export interface IntegrationCard {
  id: string;
  name: string;
  category: IntegrationCategory;
  icon: IntegrationIcon;
  /** One line: what it does for the person, not how it works. */
  description: string;
  state: IntegrationState;
  /** "2 connected", "Test email not sent yet" — plain words, never a code. */
  detail: string | null;
  /** The button: where to go, and what it says. */
  action: { label: string; href: string; external?: boolean } | null;
  /** A second, quieter link (manage when the main action adds). */
  secondary: { label: string; href: string } | null;
  /** Words for searching beyond the name. */
  keywords: string;
}

type Status = { state: Exclude<IntegrationState, "MODULE_OFF">; detail: string | null };

interface Definition {
  id: string;
  name: string;
  category: IntegrationCategory;
  icon: IntegrationIcon;
  description: string;
  keywords: string;
  /** The integration's own page: decides visibility (key, module, page access) and is the "Manage" link. */
  page: string;
  /** Where adding one starts, when that is not the page itself. */
  addHref?: string;
  /** A module the card also needs beyond the page's own (e.g. official WhatsApp on the channels page). */
  feature?: string;
  status: () => Promise<Status>;
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function fromCounts(working: number, broken: number, noun: string, brokenWords = "needs attention"): Status {
  if (working > 0) return { state: "CONNECTED", detail: `${count(working, noun)} connected${broken > 0 ? `, ${broken} ${brokenWords}` : ""}` };
  if (broken > 0) return { state: "ATTENTION", detail: `${count(broken, noun)} ${brokenWords}` };
  return { state: "NOT_SET_UP", detail: null };
}

async function channelStatus(type: "MESSENGER" | "INSTAGRAM" | "TELEGRAM" | "WHATSAPP_CLOUD" | "WEBCHAT", noun: string): Promise<Status> {
  const rows = await prisma.channelConnection.groupBy({ by: ["status"], where: { type, status: { not: "DISCONNECTED" } }, _count: { _all: true } });
  const n = (s: string) => rows.find((r) => r.status === s)?._count._all ?? 0;
  return fromCounts(n("CONNECTED"), n("ERROR") + n("NEEDS_RECONNECT") + n("SETUP_REQUIRED"), noun, "not finished");
}

const DEFINITIONS: Definition[] = [
  {
    id: "whatsapp",
    name: "WhatsApp numbers",
    category: "Messaging",
    icon: "whatsapp",
    description: "Link a WhatsApp number by scanning a QR code. Its groups and chats arrive here automatically.",
    keywords: "whatsapp qr number phone groups",
    page: "/accounts",
    status: async () => {
      const rows = await prisma.whatsAppAccount.groupBy({ by: ["status"], _count: { _all: true } });
      const connected = rows.find((r) => r.status === "CONNECTED")?._count._all ?? 0;
      const needsPhone = rows.filter((r) => r.status === "AUTHENTICATION_REQUIRED" || r.status === "SESSION_ERROR" || r.status === "ERROR").reduce((a, r) => a + r._count._all, 0);
      return fromCounts(connected, needsPhone, "number", "need the phone to link again");
    },
  },
  {
    id: "whatsapp-cloud",
    name: "WhatsApp Business (official)",
    category: "Messaging",
    icon: "whatsapp",
    description: "Meta's official WhatsApp Business Platform, for a number that runs on Meta's cloud.",
    keywords: "whatsapp cloud api official meta business",
    page: "/settings/channels",
    addHref: "/settings/channels/new?type=WHATSAPP_CLOUD",
    feature: "WHATSAPP_OFFICIAL",
    status: () => channelStatus("WHATSAPP_CLOUD", "number"),
  },
  {
    id: "messenger",
    name: "Facebook Messenger",
    category: "Messaging",
    icon: "messenger",
    description: "Answer your Facebook Page's messages from the shared inbox.",
    keywords: "facebook messenger page meta",
    page: "/settings/channels",
    addHref: "/settings/channels/new?type=MESSENGER",
    status: () => channelStatus("MESSENGER", "Page"),
  },
  {
    id: "instagram",
    name: "Instagram",
    category: "Messaging",
    icon: "instagram",
    description: "Answer Instagram direct messages from the shared inbox.",
    keywords: "instagram dm direct messages meta",
    page: "/settings/channels",
    addHref: "/settings/channels/new?type=INSTAGRAM",
    status: () => channelStatus("INSTAGRAM", "account"),
  },
  {
    id: "telegram",
    name: "Telegram",
    category: "Messaging",
    icon: "telegram",
    description: "Connect a Telegram bot and answer its chats from the shared inbox.",
    keywords: "telegram bot",
    page: "/settings/channels",
    addHref: "/settings/channels/new?type=TELEGRAM",
    status: () => channelStatus("TELEGRAM", "bot"),
  },
  {
    id: "webchat",
    name: "Website chat",
    category: "Messaging",
    icon: "webchat",
    description: "A chat bubble for your website. Copy one line onto the site, or install the WordPress plugin.",
    keywords: "website chat widget wordpress live chat",
    page: "/website-chat/widgets",
    addHref: "/website-chat/widgets/new",
    status: () => channelStatus("WEBCHAT", "widget"),
  },
  {
    id: "email",
    name: "Email",
    category: "Messaging",
    icon: "email",
    description: "Send email from your own mail server (SMTP), such as invoices and client messages.",
    keywords: "email smtp mail gmail outlook",
    page: "/settings/email",
    status: async () => {
      const s = await prisma.emailSettings.findFirst({ select: { enabled: true, settingsVersion: true, verifiedVersion: true } });
      if (!s) return { state: "NOT_SET_UP", detail: null };
      if (s.verifiedVersion === s.settingsVersion && s.enabled) return { state: "CONNECTED", detail: "Sending" };
      if (s.verifiedVersion !== s.settingsVersion) return { state: "ATTENTION", detail: "Send a test email to finish" };
      return { state: "ATTENTION", detail: "Tested, but switched off" };
    },
  },
  {
    id: "woocommerce",
    name: "WooCommerce",
    category: "Selling & delivery",
    icon: "woocommerce",
    description: "Bring your WordPress shop's orders in automatically.",
    keywords: "woocommerce wordpress shop store orders",
    page: "/settings/woocommerce",
    status: async () => shopStatus("WOOCOMMERCE"),
  },
  {
    id: "shopify",
    name: "Shopify",
    category: "Selling & delivery",
    icon: "shopify",
    description: "Bring your Shopify store's orders in automatically.",
    keywords: "shopify shop store orders",
    page: "/settings/shopify",
    status: async () => shopStatus("SHOPIFY"),
  },
  {
    id: "couriers",
    name: "Couriers",
    category: "Selling & delivery",
    icon: "courier",
    description: "Book Steadfast, Pathao or RedX from an order. Delivery status updates by itself.",
    keywords: "courier delivery steadfast pathao redx shipping parcel",
    page: "/settings/couriers",
    status: async () => {
      const [working, broken] = await Promise.all([
        prisma.courierConnection.count({ where: { isActive: true, lastError: null } }),
        prisma.courierConnection.count({ where: { isActive: true, NOT: { lastError: null } } }),
      ]);
      return fromCounts(working, broken, "courier");
    },
  },
  {
    id: "payments",
    name: "Online payments",
    category: "Selling & delivery",
    icon: "payments",
    description: "Take payments through SSLCommerz or bKash with a payment link.",
    keywords: "payment sslcommerz bkash pay link card",
    page: "/settings/payment-gateways",
    status: async () => {
      const [on, off] = await Promise.all([
        prisma.paymentGateway.count({ where: { enabled: true } }),
        prisma.paymentGateway.count({ where: { enabled: false } }),
      ]);
      return fromCounts(on, off, "payment account", "saved but switched off");
    },
  },
  {
    id: "google-sheets",
    name: "Google Sheets",
    category: "Tools & AI",
    icon: "sheets",
    description: "Open and edit your team's spreadsheets here, and see who worked on them.",
    keywords: "google sheets spreadsheet drive",
    page: "/settings/google-sheets",
    status: async () => {
      const rows = await prisma.googleIntegrationAccount.groupBy({ by: ["status"], _count: { _all: true } });
      const n = (s: string) => rows.find((r) => r.status === s)?._count._all ?? 0;
      return fromCounts(n("CONNECTED"), n("NEEDS_RECONNECT"), "Google account", "need to sign in again");
    },
  },
  {
    id: "ai",
    name: "AI providers",
    category: "Tools & AI",
    icon: "ai",
    description: "Connect OpenAI, Anthropic, Google Gemini, OpenRouter or a local Ollama for AI answers.",
    keywords: "ai openai anthropic claude gemini openrouter ollama gpt",
    page: "/ai-learning/providers",
    status: async () => {
      const [active, inactive] = await Promise.all([
        prisma.aiProvider.count({ where: { status: "ACTIVE" } }),
        prisma.aiProvider.count({ where: { status: { not: "ACTIVE" } } }),
      ]);
      return fromCounts(active, inactive, "provider", "switched off");
    },
  },
  {
    id: "product-knowledge",
    name: "Product knowledge",
    category: "Tools & AI",
    icon: "knowledge",
    description: "Let the AI learn your product from its documentation, through Softify Forge.",
    keywords: "forge product knowledge documentation docs",
    page: "/integrations/forge",
    status: async () => {
      const s = await prisma.forgeSettings.findFirst({ select: { enabled: true } });
      return s?.enabled ? { state: "CONNECTED", detail: "Learning from your product" } : { state: "NOT_SET_UP", detail: null };
    },
  },
  {
    id: "social",
    name: "Social publishing",
    category: "Tools & AI",
    icon: "social",
    description: "Plan and publish posts to your Facebook Pages and Instagram accounts.",
    keywords: "social facebook instagram posts publishing schedule",
    page: "/settings/social",
    status: async () => {
      const [working, broken] = await Promise.all([
        prisma.socialAccount.count({ where: { removedAt: null, enabled: true, status: "ACTIVE" } }),
        prisma.socialAccount.count({ where: { removedAt: null, NOT: { status: "ACTIVE" } } }),
      ]);
      return fromCounts(working, broken, "account");
    },
  },
  {
    id: "api",
    name: "API & webhooks",
    category: "Developers",
    icon: "api",
    description: "Connect your own systems, n8n, Zapier or Make with an API key and signed webhooks.",
    keywords: "api key webhooks zapier n8n make developer",
    page: "/settings/api",
    status: async () => {
      const [keys, hooks] = await Promise.all([
        prisma.apiKey.count({ where: { revokedAt: null } }),
        prisma.webhookEndpoint.count({ where: { isActive: true } }),
      ]);
      if (keys + hooks === 0) return { state: "NOT_SET_UP", detail: null };
      return { state: "CONNECTED", detail: [keys ? count(keys, "API key") : null, hooks ? count(hooks, "webhook") : null].filter(Boolean).join(", ") };
    },
  },
];

async function shopStatus(provider: "WOOCOMMERCE" | "SHOPIFY"): Promise<Status> {
  const [working, broken] = await Promise.all([
    prisma.shopConnection.count({ where: { provider, isActive: true, lastError: null } }),
    prisma.shopConnection.count({ where: { provider, isActive: true, NOT: { lastError: null } } }),
  ]);
  return fromCounts(working, broken, "store");
}

/** The cards this person sees in the active project, each with its real state. */
export async function integrationsFor(session: Session): Promise<IntegrationCard[]> {
  const project = await requireActiveProject();
  const [grantedList, disabled, pageAccess] = await Promise.all([getGrantedPermissionKeys(session), activeDisabledFeatures(), getPageAccess(session)]);
  const granted = new Set(grantedList);
  const mayOpen = (href: string) => {
    const key = navPermissionFor(href);
    return (key === null || granted.has(key)) && (!pageAccess || canOpenPath(href.split("?")[0]!, pageAccess));
  };

  const cards = await Promise.all(
    DEFINITIONS.filter((d) => mayOpen(d.page)).map(async (d): Promise<IntegrationCard> => {
      const base = { id: d.id, name: d.name, category: d.category, icon: d.icon, description: d.description, keywords: d.keywords };
      const moduleOff = !pathAllowedByFeatures(d.page, disabled) || (d.feature !== undefined && disabled.has(d.feature as ProjectFeatureKey));
      if (moduleOff) {
        return { ...base, state: "MODULE_OFF", detail: "Switched off for this project. A Main Admin can turn it on in Modules.", action: null, secondary: null };
      }
      // A table that cannot be read must not take the whole page down: the card still opens its page.
      const status: Status = await d.status().catch(() => ({ state: "NOT_SET_UP" as const, detail: null }));
      const addHref = d.addHref ?? d.page;
      if (status.state === "NOT_SET_UP") return { ...base, ...status, action: { label: "Connect", href: addHref }, secondary: null };
      if (status.state === "ATTENTION") return { ...base, ...status, action: { label: "Fix", href: d.page }, secondary: null };
      return { ...base, ...status, action: { label: "Manage", href: d.page }, secondary: d.addHref ? { label: "Add another", href: d.addHref } : null };
    }),
  );

  const commerce = await commerceCard(granted, project.id, mayOpen);
  return commerce ? [...cards, commerce] : cards;
}

/** The Commerce Business App: opened from the workspace, added and connected by a Main Admin. */
async function commerceCard(granted: Set<string>, projectId: string, mayOpen: (href: string) => boolean): Promise<IntegrationCard | null> {
  const canManage = granted.has("projects.manage");
  if (!mayOpen("/apps/commerce") && !canManage) return null;
  const row = await prisma.projectAppInstallation.findFirst({ where: { appKey: "commerce" }, select: { status: true, lastError: true } }).catch(() => null);
  const base = {
    id: "commerce",
    name: "Commerce",
    category: "Selling & delivery" as const,
    icon: "commerce" as const,
    description: "Your Commerce store's dashboard inside this workspace, and its live prices and stock for the AI.",
    keywords: "commerce erp store products stock orders business app",
  };
  const admin = { label: canManage ? (row ? "Manage" : "Add") : "", href: `/admin/projects/${projectId}?tab=apps`, external: true };
  if (row?.status === "ACTIVE") {
    return {
      ...base,
      state: "CONNECTED",
      detail: "Connected to your Commerce workspace",
      action: mayOpen("/apps/commerce") ? { label: "Open", href: "/apps/commerce" } : canManage ? admin : null,
      secondary: canManage && mayOpen("/apps/commerce") ? { label: "Manage", href: admin.href } : null,
    };
  }
  const detail = !row
    ? canManage ? null : "A Main Admin can add it to this project."
    : row.status === "DISABLED" ? "Switched off by a Main Admin."
    : row.status === "ERROR" ? (row.lastError ?? "The last connection check failed.")
    : "Added, waiting to be connected.";
  return { ...base, state: row ? "ATTENTION" : "NOT_SET_UP", detail, action: canManage ? { ...admin, label: row ? "Connect" : "Add" } : null, secondary: null };
}
