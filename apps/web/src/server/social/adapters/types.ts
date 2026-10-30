import type { PublishOutcome, RecentPublication, SocialMediaKind, SocialMetricValue, SocialPlatform } from "@support-automation/shared";

/**
 * A Social Studio platform adapter (SOCIAL_STUDIO.md §Adapters): Get Assist's own code for ONE platform's
 * official publishing API. An adapter does HTTP and nothing else — no database, no project, no retry
 * policy. It reports each attempt as a `PublishOutcome`; the engine decides what that means for the job.
 *
 * The one rule every adapter keeps: call `ctx.markSent()` immediately before the request that makes the
 * post public. Before it, a failure is safe to repeat; after it, an answer not seen is UNKNOWN.
 */

export interface AdapterAccount {
  platform: SocialPlatform;
  externalId: string;
  parentExternalId: string | null;
  /** The account's access token, decrypted for this call only. */
  token: string;
}

export interface AdapterMedia {
  kind: SocialMediaKind;
  mimeType: string;
  sizeBytes: number;
  /** A short-lived signed https address the platform fetches the file from. */
  url: string;
}

export interface PublishInput {
  account: AdapterAccount;
  text: string;
  media: AdapterMedia[];
  settings: Record<string, unknown>;
  /** Instagram: containers an earlier attempt made and saved (re-used rather than made again). */
  containerIds: string[];
}

export interface AdapterContext {
  fetch: typeof fetch;
  /** Immediately before the request that publishes. Records it durably before returning. */
  markSent(): Promise<void>;
  /** Saves intermediate ids (Instagram containers) so a later attempt can continue from them. */
  saveContainers(ids: string[]): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export type ReadContext = Pick<AdapterContext, "fetch">;

export interface SocialAdapter {
  platform: SocialPlatform;
  publish(input: PublishInput, ctx: AdapterContext): Promise<PublishOutcome>;
  /** The account's publications since a time, for settling an unknown outcome. Throws when unreadable. */
  findRecent(account: AdapterAccount, since: Date, ctx: ReadContext): Promise<RecentPublication[]>;
  /** Only where the platform's API supports it (capability DELETE). */
  deletePublication?(account: AdapterAccount, externalId: string, ctx: ReadContext): Promise<{ ok: true } | { ok: false; message: string }>;
  /** Only the counts the platform returns (capability POST_METRICS). Null when unreadable. */
  metrics?(account: AdapterAccount, externalId: string, ctx: ReadContext): Promise<SocialMetricValue[] | null>;
}
