import { randomBytes, timingSafeEqual } from "node:crypto";
import { CHANNELS, isAiDisclosureChannel, metaPlatformAppSecret, validateAiDisclosureIdleHours, validateAiDisclosureText, type ChannelType } from "@support-automation/shared";
import { decryptSecret, encryptSecret } from "@support-automation/db";
import type { ChannelAuthMode, ChannelConnectionStatus } from "@prisma/client";
import { platformPrisma, prisma } from "@/server/db";
import { publicOrigin } from "@/server/google/oauth";
import {
  checkMetaApp,
  readLinkedInstagram,
  readMetaPage,
  readMetaPageSubscriptions,
  subscribeMetaPage,
  telegramDeleteWebhook,
  telegramGetMe,
  telegramGetWebhookInfo,
  telegramSetWebhook,
  unsubscribeMetaPage,
  type FetchImpl,
} from "@/server/channels/providerApi";

/**
 * Connected Messenger Pages, Instagram accounts and Telegram bots (OMNICHANNEL.md §6).
 *
 * The ONE file in the web app that decrypts a channel credential. Everything that leaves it for a
 * page is `ChannelConnectionView`, which says whether a credential is set and never what it is; the
 * single exception is the Meta verify token, returned only when the caller asks for it (a manager's
 * settings page), because the admin has to paste it into Meta's dashboard.
 *
 * Every read and write goes through the project-scoped client, so a connection of another project is
 * simply not found — except `loadWebhookConnection`, which runs for a webhook that arrives outside any
 * project and finds its connection by the unguessable key in the URL (the row is then the authority
 * for the project, exactly like the account row in the worker).
 */

export class ChannelConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelConnectionError";
  }
}

const newKey = (bytes = 24) => randomBytes(bytes).toString("base64url");

/** Where a provider must send this connection's webhooks. Null when the server's address is unknown. */
export function webhookUrlFor(type: ChannelType, webhookKey: string): string | null {
  const origin = publicOrigin();
  if (!origin) return null;
  const kind = CHANNELS[type].webhookKind;
  // Website chat has no webhook: its "address" is the widget's own API base.
  if (kind === "WEBCHAT") return `${origin}/api/webchat/${webhookKey}`;
  return `${origin}/api/channels/${kind === "META" ? "meta" : "telegram"}/${webhookKey}`;
}

export interface ChannelConnectionView {
  id: string;
  type: ChannelType;
  name: string;
  status: ChannelConnectionStatus;
  enabled: boolean;
  externalAccountId: string | null;
  externalAccountName: string | null;
  externalUsername: string | null;
  pageId: string | null;
  appId: string | null;
  /** MANUAL: the project's own app and token. PLATFORM: connected with "Connect with Facebook". */
  authMode: ChannelAuthMode;
  /** PLATFORM: the permissions Meta reported as granted. */
  grantedScopes: string[];
  hasCredentials: boolean;
  aiAutomationEnabled: boolean;
  humanAgentEnabled: boolean;
  aiDisclosureEnabled: boolean;
  aiDisclosureText: string | null;
  aiDisclosureIdleHours: number;
  webhookUrl: string | null;
  webhookVerifiedAt: Date | null;
  lastEventAt: Date | null;
  lastCheckedAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  credentialsUpdatedAt: Date | null;
  credentialsUpdatedByUsername: string | null;
  createdByUsername: string | null;
  disconnectedAt: Date | null;
  createdAt: Date;
  conversationCount: number;
  /** Only when asked for, and only for Meta: the token to paste into the app dashboard. */
  verifyToken?: string | null;
}

const VIEW_SELECT = {
  id: true,
  type: true,
  name: true,
  status: true,
  enabled: true,
  webhookKey: true,
  externalAccountId: true,
  externalAccountName: true,
  externalUsername: true,
  pageId: true,
  appId: true,
  authMode: true,
  grantedScopes: true,
  accessTokenCiphertext: true,
  aiAutomationEnabled: true,
  humanAgentEnabled: true,
  aiDisclosureEnabled: true,
  aiDisclosureText: true,
  aiDisclosureIdleHours: true,
  webhookVerifiedAt: true,
  lastEventAt: true,
  lastCheckedAt: true,
  lastError: true,
  lastErrorAt: true,
  credentialsUpdatedAt: true,
  credentialsUpdatedByUsername: true,
  createdByUsername: true,
  disconnectedAt: true,
  createdAt: true,
  verifyTokenCiphertext: true,
  _count: { select: { conversations: true } },
} as const;

type ViewRow = NonNullable<Awaited<ReturnType<typeof readViewRow>>>;
const readViewRow = (id: string) => prisma.channelConnection.findUnique({ where: { id }, select: VIEW_SELECT });

function toView(row: ViewRow, revealVerifyToken: boolean): ChannelConnectionView {
  let verifyToken: string | null | undefined;
  if (revealVerifyToken && CHANNELS[row.type].webhookKind === "META" && row.authMode === "MANUAL") {
    try {
      verifyToken = row.verifyTokenCiphertext ? decryptSecret(row.verifyTokenCiphertext) : null;
    } catch {
      verifyToken = null;
    }
  }
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    status: row.status,
    enabled: row.enabled,
    externalAccountId: row.externalAccountId,
    externalAccountName: row.externalAccountName,
    externalUsername: row.externalUsername,
    pageId: row.pageId,
    appId: row.appId,
    authMode: row.authMode,
    grantedScopes: row.grantedScopes,
    hasCredentials: Boolean(row.accessTokenCiphertext),
    aiAutomationEnabled: row.aiAutomationEnabled,
    humanAgentEnabled: row.humanAgentEnabled,
    aiDisclosureEnabled: row.aiDisclosureEnabled,
    aiDisclosureText: row.aiDisclosureText,
    aiDisclosureIdleHours: row.aiDisclosureIdleHours,
    // A one-click connection uses the platform app's single webhook, which the customer never configures.
    webhookUrl: row.status === "DISCONNECTED" || row.authMode === "PLATFORM" ? null : webhookUrlFor(row.type, row.webhookKey),
    webhookVerifiedAt: row.webhookVerifiedAt,
    lastEventAt: row.lastEventAt,
    lastCheckedAt: row.lastCheckedAt,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt,
    credentialsUpdatedAt: row.credentialsUpdatedAt,
    credentialsUpdatedByUsername: row.credentialsUpdatedByUsername,
    createdByUsername: row.createdByUsername,
    disconnectedAt: row.disconnectedAt,
    createdAt: row.createdAt,
    conversationCount: row._count.conversations,
    ...(verifyToken !== undefined ? { verifyToken } : {}),
  };
}

export async function listChannelConnections(): Promise<ChannelConnectionView[]> {
  const rows = await prisma.channelConnection.findMany({ select: VIEW_SELECT, orderBy: [{ type: "asc" }, { createdAt: "asc" }] });
  return rows.map((row) => toView(row, false));
}

export async function getChannelConnection(id: string, opts: { revealVerifyToken?: boolean } = {}): Promise<ChannelConnectionView | null> {
  const row = await readViewRow(id);
  return row ? toView(row, opts.revealVerifyToken ?? false) : null;
}

// ─── Connecting ────────────────────────────────────────────────────────────────────────────────

export interface MetaCredentialsInput {
  type: "MESSENGER" | "INSTAGRAM";
  appId: string;
  appSecret: string;
  pageAccessToken: string;
}

interface MetaIdentity {
  pageId: string;
  pageName: string;
  externalAccountId: string;
  externalAccountName: string;
  externalUsername: string | null;
}

/** Check a Meta app + Page token with Meta and work out which account they are for. Throws a reason. */
async function identifyMeta(input: MetaCredentialsInput, fetchImpl: FetchImpl): Promise<MetaIdentity> {
  const appId = input.appId.trim();
  const appSecret = input.appSecret.trim();
  const token = input.pageAccessToken.trim();
  if (!/^\d{5,20}$/.test(appId)) throw new ChannelConnectionError("The App ID is the number at the top of your app in Meta for Developers (App settings → Basic).");
  if (!/^[a-f0-9]{32}$/i.test(appSecret)) throw new ChannelConnectionError("That does not look like an App Secret (32 letters and digits). Copy it from App settings → Basic → App secret → Show.");
  if (token.length < 20 || /\s/.test(token)) throw new ChannelConnectionError("Paste the Page access token exactly as Meta shows it.");

  const app = await checkMetaApp(appId, appSecret, fetchImpl);
  if (!app.ok) {
    throw new ChannelConnectionError(app.status === 0 ? app.error.message : "Meta did not accept this App ID and App Secret together. Check both under App settings → Basic.");
  }
  const page = await readMetaPage(token, appSecret, fetchImpl);
  if (!page.ok) {
    if (page.status === 0) throw new ChannelConnectionError(page.error.message);
    throw new ChannelConnectionError(
      page.error.needsReauth
        ? "Meta did not accept the Page access token (it may have expired). Generate a new one for the Page and paste it again."
        : "Meta did not accept this as a Page access token. A token for your own Facebook profile (a user token) will not work — generate one for the Page itself (Messenger → Settings → Access tokens, or a system user's Page token).",
    );
  }
  if (!page.data.category) {
    throw new ChannelConnectionError("This token belongs to a person, not a Page. Generate a token for the Page itself and paste that.");
  }
  if (input.type === "MESSENGER") {
    return { pageId: page.data.id, pageName: page.data.name, externalAccountId: page.data.id, externalAccountName: page.data.name, externalUsername: null };
  }
  const ig = await readLinkedInstagram(page.data.id, token, appSecret, fetchImpl);
  if (!ig.ok) throw new ChannelConnectionError(ig.status === 0 ? ig.error.message : `Meta would not say which Instagram account is linked to ${page.data.name}: ${ig.error.message}`);
  const account = ig.data.instagram_business_account;
  if (!account?.id) {
    throw new ChannelConnectionError(
      `${page.data.name} has no Instagram professional account linked to it. Link one in Meta Business Suite (Settings → Accounts → Instagram accounts), or connect the Page as Messenger instead.`,
    );
  }
  return {
    pageId: page.data.id,
    pageName: page.data.name,
    externalAccountId: account.id,
    externalAccountName: account.name ?? account.username ?? page.data.name,
    externalUsername: account.username ?? null,
  };
}

export interface ConnectResult {
  id: string;
  status: ChannelConnectionStatus;
  /** Something that needs the admin's attention even though it was saved (the webhook not registered). */
  warning: string | null;
}

async function existingFor(type: ChannelType, externalAccountId: string) {
  return prisma.channelConnection.findFirst({ where: { type, externalAccountId }, select: { id: true, status: true, webhookKey: true } });
}

/** Connect a Facebook Page (Messenger) or the Instagram account linked to one. */
export async function connectMeta(input: MetaCredentialsInput & { username: string; fetchImpl?: FetchImpl; now?: Date }): Promise<ConnectResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? new Date();
  const identity = await identifyMeta(input, fetchImpl);
  const existing = await existingFor(input.type, identity.externalAccountId);
  if (existing && existing.status !== "DISCONNECTED") {
    throw new ChannelConnectionError(`${identity.externalAccountName} is already connected in this project. Open it to update its credentials.`);
  }

  const subscribed = await subscribeMetaPage(identity.pageId, input.pageAccessToken.trim(), input.appSecret.trim(), fetchImpl);
  const warning = subscribed.ok ? null : `Saved, but Meta did not subscribe the Page to the app, so no messages will arrive yet: ${subscribed.error.message}`;
  const data = {
    name: input.type === "INSTAGRAM" && identity.externalUsername ? `@${identity.externalUsername}` : identity.externalAccountName,
    status: (subscribed.ok ? "CONNECTED" : "ERROR") as ChannelConnectionStatus,
    enabled: true,
    externalAccountName: identity.externalAccountName,
    externalUsername: identity.externalUsername,
    pageId: identity.pageId,
    appId: input.appId.trim(),
    accessTokenCiphertext: encryptSecret(input.pageAccessToken.trim()),
    appSecretCiphertext: encryptSecret(input.appSecret.trim()),
    lastCheckedAt: now,
    lastError: warning,
    lastErrorAt: warning ? now : null,
    credentialsUpdatedAt: now,
    credentialsUpdatedByUsername: input.username,
    disconnectedAt: null,
  };
  if (existing) {
    // A disconnected connection comes back as the same row, so its conversations and history are
    // simply there again. A new webhook key: the old URL stopped working when it was disconnected.
    await prisma.channelConnection.update({
      where: { id: existing.id },
      data: { ...data, webhookKey: newKey(), verifyTokenCiphertext: encryptSecret(newKey(18)), webhookVerifiedAt: null },
    });
    return { id: existing.id, status: data.status, warning };
  }
  const created = await prisma.channelConnection.create({
    data: {
      ...data,
      type: input.type,
      externalAccountId: identity.externalAccountId,
      webhookKey: newKey(),
      verifyTokenCiphertext: encryptSecret(newKey(18)),
      createdByUsername: input.username,
    },
    select: { id: true },
  });
  return { id: created.id, status: data.status, warning };
}

/** Replace a Meta connection's credentials (a new token, a rotated secret). It must stay the same account. */
export async function updateMetaCredentials(id: string, input: Omit<MetaCredentialsInput, "type"> & { username: string; fetchImpl?: FetchImpl; now?: Date }): Promise<ConnectResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? new Date();
  const row = await prisma.channelConnection.findUnique({ where: { id }, select: { id: true, type: true, status: true, authMode: true, externalAccountId: true, externalAccountName: true, verifyTokenCiphertext: true } });
  if (!row || (row.type !== "MESSENGER" && row.type !== "INSTAGRAM")) throw new ChannelConnectionError("That connection no longer exists.");
  // Reconnecting after a disconnect (or leaving one-click): the old webhook address and verify token no longer apply.
  const freshWebhook = row.status === "DISCONNECTED" || row.authMode === "PLATFORM" || !row.verifyTokenCiphertext ? { webhookKey: newKey(), verifyTokenCiphertext: encryptSecret(newKey(18)), webhookVerifiedAt: null } : {};
  const identity = await identifyMeta({ ...input, type: row.type }, fetchImpl);
  if (identity.externalAccountId !== row.externalAccountId) {
    throw new ChannelConnectionError(
      `These credentials are for ${identity.externalAccountName}, not ${row.externalAccountName ?? "this connection's account"}. Add it as a new connection instead.`,
    );
  }
  const subscribed = await subscribeMetaPage(identity.pageId, input.pageAccessToken.trim(), input.appSecret.trim(), fetchImpl);
  const warning = subscribed.ok ? null : `Saved, but Meta did not subscribe the Page to the app: ${subscribed.error.message}`;
  const status: ChannelConnectionStatus = subscribed.ok ? "CONNECTED" : "ERROR";
  await prisma.channelConnection.update({
    where: { id },
    data: {
      status,
      enabled: true,
      appId: input.appId.trim(),
      pageId: identity.pageId,
      externalAccountName: identity.externalAccountName,
      externalUsername: identity.externalUsername,
      accessTokenCiphertext: encryptSecret(input.pageAccessToken.trim()),
      appSecretCiphertext: encryptSecret(input.appSecret.trim()),
      // Credentials typed in here are the project's own app: whatever it was before, it is MANUAL now.
      authMode: "MANUAL",
      metaOAuthSessionId: null,
      metaUserId: null,
      grantedScopes: [],
      pageTasks: [],
      lastCheckedAt: now,
      lastError: warning,
      lastErrorAt: warning ? now : null,
      credentialsUpdatedAt: now,
      credentialsUpdatedByUsername: input.username,
      disconnectedAt: null,
      ...freshWebhook,
    },
  });
  return { id, status, warning };
}

const TELEGRAM_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,}$/;

/** Connect a Telegram bot by its BotFather token, and register this server as its webhook. */
export async function connectTelegram(input: { botToken: string; username: string; fetchImpl?: FetchImpl; now?: Date }): Promise<ConnectResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? new Date();
  const token = input.botToken.trim();
  if (!TELEGRAM_TOKEN.test(token)) throw new ChannelConnectionError("That is not a bot token. BotFather gives it as digits, a colon and a long code (123456789:AA…).");
  const me = await telegramGetMe(token, fetchImpl);
  if (!me.ok) throw new ChannelConnectionError(me.status === 0 ? me.error.message : "Telegram did not accept this bot token. Copy it again from BotFather (/mybots → your bot → API Token).");
  if (!me.data.is_bot) throw new ChannelConnectionError("That token is not a bot's.");
  const externalAccountId = String(me.data.id);
  const existing = await existingFor("TELEGRAM", externalAccountId);
  if (existing && existing.status !== "DISCONNECTED") {
    throw new ChannelConnectionError(`@${me.data.username ?? me.data.first_name} is already connected in this project. Open it to update its token.`);
  }

  const webhookKey = newKey();
  const secret = newKey(32);
  const url = webhookUrlFor("TELEGRAM", webhookKey);
  let warning: string | null = null;
  if (!url) {
    warning = "Saved, but the server's public address (NEXTAUTH_URL) is not set, so Telegram cannot be told where to send messages.";
  } else if (!url.startsWith("https://")) {
    warning = `Saved, but Telegram only delivers to an https:// address and this server is ${new URL(url).origin}. Messages will arrive once the app is served over HTTPS and the webhook is registered again.`;
  } else {
    const set = await telegramSetWebhook(token, url, secret, fetchImpl);
    if (!set.ok) warning = `Saved, but Telegram refused to register the webhook: ${set.error.message}`;
  }
  const data = {
    name: me.data.username ? `@${me.data.username}` : me.data.first_name,
    status: (warning ? "ERROR" : "CONNECTED") as ChannelConnectionStatus,
    enabled: true,
    externalAccountName: me.data.first_name,
    externalUsername: me.data.username ?? null,
    accessTokenCiphertext: encryptSecret(token),
    webhookSecretCiphertext: encryptSecret(secret),
    webhookKey,
    webhookVerifiedAt: warning ? null : now,
    lastCheckedAt: now,
    lastError: warning,
    lastErrorAt: warning ? now : null,
    credentialsUpdatedAt: now,
    credentialsUpdatedByUsername: input.username,
    disconnectedAt: null,
  };
  if (existing) {
    await prisma.channelConnection.update({ where: { id: existing.id }, data });
    return { id: existing.id, status: data.status, warning };
  }
  const created = await prisma.channelConnection.create({
    data: { ...data, type: "TELEGRAM", externalAccountId, createdByUsername: input.username },
    select: { id: true },
  });
  return { id: created.id, status: data.status, warning };
}

/** Telegram: a new token for the same bot (after /revoke in BotFather), or just re-register the webhook. */
export async function updateTelegramToken(id: string, input: { botToken: string | null; username: string; fetchImpl?: FetchImpl; now?: Date }): Promise<ConnectResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? new Date();
  const row = await prisma.channelConnection.findUnique({
    where: { id },
    select: { id: true, type: true, status: true, externalAccountId: true, name: true, webhookKey: true, accessTokenCiphertext: true, webhookSecretCiphertext: true },
  });
  if (!row || row.type !== "TELEGRAM") throw new ChannelConnectionError("That connection no longer exists.");
  // Reconnecting after a disconnect gets a new webhook address; the old one stopped working then.
  const webhookKey = row.status === "DISCONNECTED" ? newKey() : row.webhookKey;
  let token: string;
  if (input.botToken?.trim()) {
    token = input.botToken.trim();
    if (!TELEGRAM_TOKEN.test(token)) throw new ChannelConnectionError("That is not a bot token. BotFather gives it as digits, a colon and a long code.");
    const me = await telegramGetMe(token, fetchImpl);
    if (!me.ok) throw new ChannelConnectionError(me.status === 0 ? me.error.message : "Telegram did not accept this bot token.");
    if (String(me.data.id) !== row.externalAccountId) throw new ChannelConnectionError(`That token is for a different bot (@${me.data.username ?? me.data.first_name}). Add it as a new connection instead.`);
  } else {
    if (!row.accessTokenCiphertext) throw new ChannelConnectionError("Enter the bot token — this connection has none saved.");
    token = readSecret(row.accessTokenCiphertext);
  }
  const secret = newKey(32);
  const url = webhookUrlFor("TELEGRAM", webhookKey);
  let warning: string | null = null;
  if (!url || !url.startsWith("https://")) {
    warning = "Telegram only delivers to an https:// address, and this server's public address (NEXTAUTH_URL) is not one.";
  } else {
    const set = await telegramSetWebhook(token, url, secret, fetchImpl);
    if (!set.ok) warning = `Telegram refused to register the webhook: ${set.error.message}`;
  }
  const status: ChannelConnectionStatus = warning ? "ERROR" : "CONNECTED";
  await prisma.channelConnection.update({
    where: { id },
    data: {
      status,
      enabled: true,
      accessTokenCiphertext: encryptSecret(token),
      webhookKey,
      // A new secret only takes effect once Telegram has accepted the webhook that carries it.
      ...(warning ? {} : { webhookSecretCiphertext: encryptSecret(secret), webhookVerifiedAt: now }),
      lastCheckedAt: now,
      lastError: warning,
      lastErrorAt: warning ? now : null,
      ...(input.botToken?.trim() ? { credentialsUpdatedAt: now, credentialsUpdatedByUsername: input.username } : {}),
      disconnectedAt: null,
    },
  });
  return { id, status, warning };
}

/**
 * The app secret for a Meta connection's calls: its own (MANUAL) or the platform app's from the
 * environment (PLATFORM, never stored per connection). Null when there is none.
 */
function metaAppSecretOf(row: { authMode: ChannelAuthMode; appSecretCiphertext: string | null }): string | null {
  if (row.authMode === "PLATFORM") return metaPlatformAppSecret(process.env);
  return row.appSecretCiphertext ? readSecret(row.appSecretCiphertext) : null;
}

function readSecret(ciphertext: string): string {
  try {
    return decryptSecret(ciphertext);
  } catch {
    throw new ChannelConnectionError("The saved credential could not be read (the server's encryption key changed). Enter it again.");
  }
}

// ─── Switches ──────────────────────────────────────────────────────────────────────────────────

export async function setConnectionFlags(
  id: string,
  flags: { enabled?: boolean; aiAutomationEnabled?: boolean; humanAgentEnabled?: boolean; aiDisclosureEnabled?: boolean; aiDisclosureText?: string; aiDisclosureIdleHours?: number; name?: string },
): Promise<void> {
  const row = await prisma.channelConnection.findUnique({ where: { id }, select: { type: true, status: true } });
  if (!row) throw new ChannelConnectionError("That connection no longer exists.");
  if (row.status === "DISCONNECTED" && (flags.enabled || flags.aiAutomationEnabled)) {
    throw new ChannelConnectionError("This connection is disconnected. Enter its credentials again to reconnect it first.");
  }
  if (flags.humanAgentEnabled !== undefined && CHANNELS[row.type].replyWindow === null) {
    throw new ChannelConnectionError("Telegram has no reply window, so the Human Agent setting does not apply.");
  }
  const disclosureFlags = flags.aiDisclosureEnabled !== undefined || flags.aiDisclosureText !== undefined || flags.aiDisclosureIdleHours !== undefined;
  if (disclosureFlags && !isAiDisclosureChannel(row.type)) {
    throw new ChannelConnectionError("The automated-reply disclosure applies to Facebook Messenger and Instagram only.");
  }
  if (flags.aiDisclosureText !== undefined) {
    const problem = validateAiDisclosureText(flags.aiDisclosureText);
    if (problem) throw new ChannelConnectionError(problem);
  }
  if (flags.aiDisclosureIdleHours !== undefined) {
    const problem = validateAiDisclosureIdleHours(flags.aiDisclosureIdleHours);
    if (problem) throw new ChannelConnectionError(problem);
  }
  const name = flags.name?.trim();
  if (flags.name !== undefined && (!name || name.length > 80)) throw new ChannelConnectionError("Give the connection a name of 1–80 characters.");
  await prisma.channelConnection.update({
    where: { id },
    data: {
      ...(flags.enabled !== undefined ? { enabled: flags.enabled } : {}),
      ...(flags.aiAutomationEnabled !== undefined ? { aiAutomationEnabled: flags.aiAutomationEnabled } : {}),
      ...(flags.humanAgentEnabled !== undefined ? { humanAgentEnabled: flags.humanAgentEnabled } : {}),
      ...(flags.aiDisclosureEnabled !== undefined ? { aiDisclosureEnabled: flags.aiDisclosureEnabled } : {}),
      // Empty means "the built-in wording", stored as null so it follows any later improvement to it.
      ...(flags.aiDisclosureText !== undefined ? { aiDisclosureText: flags.aiDisclosureText.trim() || null } : {}),
      ...(flags.aiDisclosureIdleHours !== undefined ? { aiDisclosureIdleHours: flags.aiDisclosureIdleHours } : {}),
      ...(name ? { name } : {}),
    },
  });
}

/**
 * Disconnect: the provider is told to stop sending (best effort), the credentials are wiped, and the
 * connection is kept with every conversation and message — history is never deleted by this. Replies
 * still waiting to be sent are cancelled with a reason, because nothing can send them any more.
 */
export async function disconnectConnection(id: string, input: { fetchImpl?: FetchImpl; now?: Date } = {}): Promise<{ providerNotified: boolean }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? new Date();
  const row = await prisma.channelConnection.findUnique({
    where: { id },
    select: { id: true, type: true, status: true, authMode: true, pageId: true, accessTokenCiphertext: true, appSecretCiphertext: true },
  });
  if (!row) throw new ChannelConnectionError("That connection no longer exists.");
  if (row.status === "DISCONNECTED") return { providerNotified: false };
  // One-click: Messenger and Instagram on one Page share ONE subscription of the Page to the platform
  // app — and they may even be in different workspaces. The Page is unsubscribed only when no other
  // live one-click connection still rides on it.
  const pageStillUsed =
    row.authMode === "PLATFORM" && row.pageId
      ? (await platformPrisma.channelConnection.count({ where: { id: { not: row.id }, authMode: "PLATFORM", pageId: row.pageId, status: { not: "DISCONNECTED" } } })) > 0
      : false;

  let providerNotified = false;
  try {
    if (row.accessTokenCiphertext) {
      const token = decryptSecret(row.accessTokenCiphertext);
      if (row.type === "TELEGRAM") {
        providerNotified = (await telegramDeleteWebhook(token, fetchImpl)).ok;
      } else if (row.authMode === "PLATFORM") {
        const appSecret = metaAppSecretOf(row);
        if (row.pageId && appSecret && !pageStillUsed) providerNotified = (await unsubscribeMetaPage(row.pageId, token, appSecret, fetchImpl)).ok;
      } else if (row.pageId && row.appSecretCiphertext && row.type === "MESSENGER") {
        // Instagram rides on the same Page subscription a Messenger connection may still need, so only
        // a Messenger disconnect unsubscribes the Page.
        providerNotified = (await unsubscribeMetaPage(row.pageId, token, decryptSecret(row.appSecretCiphertext), fetchImpl)).ok;
      }
    }
  } catch {
    providerNotified = false;
  }

  await prisma.$transaction([
    prisma.channelConnection.update({
      where: { id },
      data: {
        status: "DISCONNECTED",
        enabled: false,
        aiAutomationEnabled: false,
        accessTokenCiphertext: null,
        appSecretCiphertext: null,
        verifyTokenCiphertext: null,
        webhookSecretCiphertext: null,
        webhookVerifiedAt: null,
        disconnectedAt: now,
        lastError: null,
        lastErrorAt: null,
      },
    }),
    prisma.channelMessage.updateMany({
      where: { connectionId: id, deliveryStatus: "QUEUED" },
      data: { deliveryStatus: "FAILED", failedAt: now, nextAttemptAt: null, lastError: "Not sent: the channel was disconnected before it could go out." },
    }),
  ]);
  return { providerNotified };
}

// ─── Health check ──────────────────────────────────────────────────────────────────────────────

export interface ConnectionCheck {
  label: string;
  ok: boolean | null;
  detail: string;
}

/** Ask the provider whether this connection still works, record the answer, and say what was checked. */
export async function testConnection(id: string, input: { fetchImpl?: FetchImpl; now?: Date } = {}): Promise<{ status: ChannelConnectionStatus; checks: ConnectionCheck[] }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? new Date();
  const row = await prisma.channelConnection.findUnique({
    where: { id },
    select: { id: true, type: true, status: true, authMode: true, appId: true, pageId: true, webhookKey: true, externalAccountId: true, webhookVerifiedAt: true, lastEventAt: true, accessTokenCiphertext: true, appSecretCiphertext: true },
  });
  if (!row) throw new ChannelConnectionError("That connection no longer exists.");
  if (row.authMode === "PLATFORM" && !row.accessTokenCiphertext && row.status !== "DISCONNECTED") {
    throw new ChannelConnectionError("Facebook no longer gives this connection access. Use Reconnect with Facebook.");
  }
  if (row.status === "DISCONNECTED" || !row.accessTokenCiphertext) throw new ChannelConnectionError("This connection is disconnected. Enter its credentials again to reconnect it.");
  const token = readSecret(row.accessTokenCiphertext);
  const checks: ConnectionCheck[] = [];
  // The worst finding wins: a dead credential (NEEDS_RECONNECT) outranks anything else (ERROR).
  const state: { status: ChannelConnectionStatus; lastError: string | null } = { status: "CONNECTED", lastError: null };
  const fail = (s: "ERROR" | "NEEDS_RECONNECT", message: string) => {
    if (state.status !== "NEEDS_RECONNECT") state.status = s;
    state.lastError ??= message;
  };

  if (row.type === "TELEGRAM") {
    const me = await telegramGetMe(token, fetchImpl);
    checks.push({ label: "Bot token accepted", ok: me.ok, detail: me.ok ? `@${me.data.username ?? me.data.first_name}` : me.error.message });
    if (!me.ok) fail(me.error.needsReauth ? "NEEDS_RECONNECT" : "ERROR", me.error.message);
    const expected = webhookUrlFor("TELEGRAM", row.webhookKey);
    const info = me.ok ? await telegramGetWebhookInfo(token, fetchImpl) : null;
    if (info?.ok) {
      const pointsHere = info.data.url === expected;
      checks.push({ label: "Webhook points to this server", ok: pointsHere, detail: pointsHere ? "Yes" : info.data.url ? "It points somewhere else — re-register the webhook here." : "No webhook is registered — re-register it." });
      if (!pointsHere) fail("ERROR", "Telegram is not sending this bot's messages here. Re-register the webhook.");
      const lastErr = info.data.last_error_message;
      checks.push({
        label: "Telegram reached this server recently",
        ok: lastErr ? false : true,
        detail: lastErr ? `Telegram's last delivery failed: ${lastErr}` : `${info.data.pending_update_count} update(s) waiting at Telegram`,
      });
    } else if (info) {
      checks.push({ label: "Webhook points to this server", ok: null, detail: info.error.message });
    }
  } else {
    const appSecret = metaAppSecretOf(row);
    if (!appSecret || !row.pageId) {
      throw new ChannelConnectionError(
        row.authMode === "PLATFORM" ? "Connecting with Facebook is not configured on this server any more. Ask your platform administrator." : "This connection's credentials are incomplete. Enter them again.",
      );
    }
    const page = await readMetaPage(token, appSecret, fetchImpl);
    const pageError = !page.ok && page.error.needsReauth && row.authMode === "PLATFORM" ? "Facebook no longer accepts this connection's access (it was removed or a password changed). Reconnect with Facebook." : page.ok ? null : page.error.message;
    checks.push({ label: "Page access token accepted", ok: page.ok, detail: page.ok ? page.data.name : pageError! });
    if (!page.ok) fail(page.error.needsReauth ? "NEEDS_RECONNECT" : "ERROR", pageError!);
    if (page.ok && row.type === "INSTAGRAM") {
      const ig = await readLinkedInstagram(row.pageId, token, appSecret, fetchImpl);
      const linked = ig.ok && ig.data.instagram_business_account?.id === row.externalAccountId;
      checks.push({ label: "Instagram account still linked to the Page", ok: linked, detail: linked ? "Yes" : ig.ok ? "The Page no longer links this Instagram account." : ig.error.message });
      if (!linked) fail("ERROR", "The Instagram account is no longer linked to the Page.");
    }
    if (page.ok) {
      const subs = await readMetaPageSubscriptions(row.pageId, token, appSecret, fetchImpl);
      const ours = subs.ok ? subs.data.data?.find((app) => app.id === row.appId) : undefined;
      checks.push({
        label: "Page subscribed to the app",
        ok: subs.ok ? Boolean(ours) : null,
        detail: subs.ok ? (ours ? (ours.subscribed_fields ?? []).join(", ") || "Yes" : "No — save the credentials again to subscribe it.") : subs.error.message,
      });
      if (subs.ok && !ours) fail("ERROR", "The Page is not subscribed to the app, so Meta sends it no messages.");
    }
    if (row.authMode === "MANUAL") {
      checks.push({
        label: "Meta verified the webhook address",
        ok: row.webhookVerifiedAt ? true : null,
        detail: row.webhookVerifiedAt ? `Verified ${row.webhookVerifiedAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : "Not yet — paste the callback URL and verify token into the app's Webhooks settings.",
      });
    }
  }
  checks.push({ label: "Last event received", ok: row.lastEventAt ? true : null, detail: row.lastEventAt ? row.lastEventAt.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "Nothing received yet." });

  await prisma.channelConnection.update({ where: { id }, data: { status: state.status, lastCheckedAt: now, lastError: state.lastError, lastErrorAt: state.lastError ? now : null } });
  return { status: state.status, checks };
}

// ─── Webhooks (outside any project) ────────────────────────────────────────────────────────────

export interface WebhookConnection {
  id: string;
  projectId: string;
  type: ChannelType;
  appId: string | null;
  externalAccountId: string | null;
  appSecret: string | null;
  verifyToken: string | null;
  webhookSecret: string | null;
}

/**
 * The connection a webhook URL names, with the secrets needed to check the request. Platform client:
 * a webhook carries no project, and the key — 24 random bytes — is the authority that names one. A
 * disconnected connection has no secrets and is treated as unknown.
 */
export async function loadWebhookConnection(webhookKey: string): Promise<WebhookConnection | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(webhookKey)) return null;
  const row = await platformPrisma.channelConnection.findUnique({
    where: { webhookKey },
    select: { id: true, projectId: true, type: true, status: true, appId: true, externalAccountId: true, appSecretCiphertext: true, verifyTokenCiphertext: true, webhookSecretCiphertext: true },
  });
  if (!row || row.status === "DISCONNECTED") return null;
  const open = (c: string | null) => {
    if (!c) return null;
    try {
      return decryptSecret(c);
    } catch {
      return null;
    }
  };
  return {
    id: row.id,
    projectId: row.projectId,
    type: row.type,
    appId: row.appId,
    externalAccountId: row.externalAccountId,
    appSecret: open(row.appSecretCiphertext),
    verifyToken: open(row.verifyTokenCiphertext),
    webhookSecret: open(row.webhookSecretCiphertext),
  };
}

/** Constant-time comparison of two secrets of any length. */
export function secretsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
