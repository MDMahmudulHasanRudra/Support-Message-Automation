import { createHmac } from "node:crypto";
import { readMetaError, readTelegramError, type ProviderErrorReading } from "@support-automation/shared";

/**
 * The provider calls the WORKER makes for Messenger, Instagram and Telegram: sending a reply and
 * looking up a customer's display name (OMNICHANNEL.md §8). The dashboard's own calls — checking
 * credentials, registering webhooks — live in apps/web/src/server/channels/providerApi.ts; the two
 * share no code because they share no calls (the Google module made the same choice).
 *
 * `fetchImpl` is injectable so tests never reach the network. Nothing returned here contains a
 * token: provider error text is read through packages/shared, which redacts them.
 */

export type FetchImpl = typeof fetch;

const SEND_TIMEOUT_MS = 20_000;
const PROFILE_TIMEOUT_MS = 5_000;

export function graphBase(): string {
  const version = process.env.META_GRAPH_API_VERSION?.trim() || "v25.0";
  return `https://graph.facebook.com/${version}`;
}

export type SendOutcome =
  | { kind: "SENT"; externalMessageId: string }
  /** The provider refused; `error` says whether to retry or reconnect. */
  | { kind: "REFUSED"; error: ProviderErrorReading }
  /** The request may or may not have reached the provider — never retried automatically. */
  | { kind: "UNKNOWN"; message: string }
  /** The request never left this server (DNS, connection refused) — safe to retry. */
  | { kind: "NOT_SENT"; message: string };

/** Errors that prove the request never reached the provider, so a retry cannot send twice. */
const NEVER_LEFT = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"]);

function readThrown(err: unknown, provider: string): SendOutcome {
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  if (code && NEVER_LEFT.has(code)) return { kind: "NOT_SENT", message: `${provider} could not be reached (${code}). It will be retried.` };
  return {
    kind: "UNKNOWN",
    message: `The request to ${provider} did not complete (${(err as Error)?.name === "TimeoutError" ? "timed out" : "connection lost"}), so it is not known whether the customer received it. Check the conversation in ${provider === "Telegram" ? "Telegram" : "Meta Business Suite"} before sending again.`,
  };
}

function appSecretProof(token: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(token).digest("hex");
}

/**
 * Send a text through a Page — Messenger, or Instagram through the Page linked to the account.
 * `metadata` (Messenger only) travels back in the echo, which is how the echo of our own send is
 * recognised and not stored a second time.
 */
export async function sendMetaText(input: {
  pageId: string;
  token: string;
  appSecret: string;
  recipientId: string;
  text: string;
  messagingType: "RESPONSE" | "MESSAGE_TAG";
  tag: "HUMAN_AGENT" | null;
  metadata: string | null;
  fetchImpl?: FetchImpl;
}): Promise<SendOutcome> {
  const url = new URL(`${graphBase()}/${encodeURIComponent(input.pageId)}/messages`);
  url.searchParams.set("appsecret_proof", appSecretProof(input.token, input.appSecret));
  const body: Record<string, unknown> = {
    recipient: { id: input.recipientId },
    messaging_type: input.messagingType,
    message: { text: input.text, ...(input.metadata ? { metadata: input.metadata } : {}) },
  };
  if (input.tag) body.tag = input.tag;
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    return readThrown(err, "Meta");
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  if (!response.ok) return { kind: "REFUSED", error: readMetaError(response.status, json) };
  const mid = (json as { message_id?: unknown } | null)?.message_id;
  if (typeof mid !== "string" || !mid) {
    return { kind: "UNKNOWN", message: "Meta answered without a message id, so delivery cannot be confirmed." };
  }
  return { kind: "SENT", externalMessageId: mid };
}

export async function sendTelegramText(input: { token: string; chatId: string; text: string; replyToMessageId: number | null; fetchImpl?: FetchImpl }): Promise<SendOutcome> {
  const payload: Record<string, unknown> = { chat_id: input.chatId, text: input.text };
  // `allow_sending_without_reply`: if the message being answered was deleted, still send the reply.
  if (input.replyToMessageId) payload.reply_parameters = { message_id: input.replyToMessageId, allow_sending_without_reply: true };
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(`https://api.telegram.org/bot${input.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    return readThrown(err, "Telegram");
  }
  type TelegramSendBody = { ok?: boolean; result?: { message_id?: number; chat?: { id?: number } } };
  let json: TelegramSendBody | null = null;
  try {
    json = (await response.json()) as TelegramSendBody;
  } catch {
    json = null;
  }
  if (!response.ok || !json?.ok) return { kind: "REFUSED", error: readTelegramError(response.status, json) };
  const messageId = json.result?.message_id;
  if (typeof messageId !== "number") return { kind: "UNKNOWN", message: "Telegram answered without a message id, so delivery cannot be confirmed." };
  return { kind: "SENT", externalMessageId: `${input.chatId}:${messageId}` };
}

/**
 * A Messenger or Instagram customer's display name, best effort. Meta may refuse it (privacy,
 * permissions); the conversation is then shown by id, which is honest and still works.
 */
export async function fetchMetaProfileName(input: { type: "MESSENGER" | "INSTAGRAM"; userId: string; token: string; appSecret: string; fetchImpl?: FetchImpl }): Promise<{ name: string | null; username: string | null }> {
  const url = new URL(`${graphBase()}/${encodeURIComponent(input.userId)}`);
  url.searchParams.set("fields", input.type === "MESSENGER" ? "first_name,last_name" : "name,username");
  url.searchParams.set("appsecret_proof", appSecretProof(input.token, input.appSecret));
  try {
    const response = await (input.fetchImpl ?? fetch)(url, { headers: { Authorization: `Bearer ${input.token}` }, signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS) });
    if (!response.ok) return { name: null, username: null };
    const json = (await response.json()) as { first_name?: string; last_name?: string; name?: string; username?: string };
    const name = input.type === "MESSENGER" ? [json.first_name, json.last_name].filter(Boolean).join(" ") || null : (json.name ?? null);
    return { name, username: json.username ?? null };
  } catch {
    return { name: null, username: null };
  }
}
