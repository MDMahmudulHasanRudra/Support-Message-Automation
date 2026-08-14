import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  create,
  ev,
  STATE,
  type ChatId,
  type Client,
  type ContactId,
  type Content,
  type GroupChatId,
  type Message as WaMessage,
} from "@open-wa/wa-automate";
import type { RawIncomingMessage } from "../../pipeline/types.js";
import type {
  AccountInfo,
  ConnectionStatus,
  GroupInfo,
  SendResult,
  WhatsAppProvider,
} from "../WhatsAppProvider.js";
import { recordAccountMetadata, recordConnectionState, type OpenWAConnectionState } from "./connectionState.js";

/** Post-connection state transitions (STATE enum) mapped onto our fine-grained lifecycle. */
function mapLibraryState(state: STATE): OpenWAConnectionState {
  switch (state) {
    case STATE.CONNECTED:
      return "CONNECTED";
    case STATE.UNPAIRED:
    case STATE.UNPAIRED_IDLE:
      return "AUTH_FAILED"; // session was logged out on the phone side — needs a fresh QR
    case STATE.OPENING:
    case STATE.PAIRING:
    case STATE.SYNCING:
      return "RECONNECTING";
    case STATE.TOS_BLOCK:
    case STATE.SMB_TOS_BLOCK:
    case STATE.PROXYBLOCK:
    case STATE.DEPRECATED_VERSION:
      return "ERROR";
    default:
      return "DISCONNECTED";
  }
}

function toInterfaceStatus(state: OpenWAConnectionState): ConnectionStatus {
  switch (state) {
    case "CONNECTED":
      return "CONNECTED";
    case "QR_AVAILABLE":
      return "AUTHENTICATION_REQUIRED";
    case "AUTH_FAILED":
      return "SESSION_ERROR";
    case "ERROR":
      return "ERROR";
    case "DISCONNECTED":
      return "DISCONNECTED";
    default:
      return "RECONNECTING";
  }
}

/**
 * PHASE 6.1 — real integration bug, reproduced live: OpenWA's `message.from`
 * is documented as "the chat from which the message was sent". For a 1:1 DM
 * that IS the sender's own JID, but for a group message it's the GROUP's
 * JID (identical to `chatId`) — the individual participant who actually
 * sent it is `message.author`. Using `.from` unconditionally meant every
 * group message's senderPhone resolved to the group's own id, confirmed via
 * a live trace where senderPhone === chatId === the group's whatsappGroupId.
 *
 * Note: with WhatsApp's newer per-participant privacy defaults, `.author`
 * can be an opaque `@lid` identifier rather than a dialable phone number —
 * that's a WhatsApp-side privacy behavior, not something this fix attempts
 * to resolve; it only corrects using the wrong field.
 */
function toRawIncomingMessage(accountId: string, message: WaMessage): RawIncomingMessage {
  return {
    accountId,
    whatsappMessageId: message.id,
    chatId: message.chatId,
    whatsappGroupId: message.isGroupMsg ? message.chatId : null,
    senderPhone: message.isGroupMsg ? message.author || message.from : message.from,
    senderName: message.sender?.pushname || message.sender?.formattedName || null,
    direction: message.fromMe ? "OUTGOING" : "INCOMING",
    body: message.body ?? message.text ?? "",
    timestampWa: new Date(message.timestamp * 1000),
  };
}

/**
 * The only module allowed to import `@open-wa/wa-automate` (per the locked
 * provider-abstraction requirement). One instance owns exactly one WhatsApp
 * session for the lifetime of the worker process.
 *
 * PHASE 5.1 — session path verification (Phase 0 adjustment #2, confirmed):
 * running this against the real stack in Docker confirmed OpenWA's session
 * data lands at `${sessionDataPath}/_IGNORE_${sessionId}` — the FULL
 * Chromium profile (cookies, local storage, IndexedDB — everything WhatsApp
 * Web needs to stay logged in), not just a small data.json. This directory
 * was inspected directly inside the mounted `whatsapp_session` volume and
 * confirmed present. `process.chdir()` into sessionDataPath before
 * connecting still matters for anything OpenWA/node-persist writes
 * relative to cwd (see below), but the primary session data's location is
 * now verified, not assumed.
 *
 * PHASE 5.1 — root cause of the QR/connection timeout: NOT a QR-scraping,
 * headless-detection, sandbox, or shared-memory issue. OpenWA 4.76.0's
 * internal `create()` (dist/controllers/initializer.js) waits for
 * `window.Debug != undefined && window.Debug.VERSION != undefined`, which
 * current WhatsApp Web (Multi-Device) no longer exposes — this condition
 * can never become true, so the wait fails after a hardcoded 30s on every
 * single attempt. This is a confirmed upstream bug (open-wa/wa-automate-
 * nodejs#3346, closed, no fix released in the 4.x line as of 4.76.0 —
 * latest stable). Patched locally via `pnpm patch` (see
 * patches/@open-wa__wa-automate@4.76.0.patch) to drop the dependency on
 * `window.Debug` and use an explicit 45s timeout instead of Puppeteer's
 * implicit 30s default. Also fixed two smaller, real contributing factors
 * found while investigating: this file was passing `headless: true`, which
 * *overrides* the library's own `headless: "new"` default (object spread
 * order in browser.js puts our config after the default) — legacy headless
 * mode is more detectable and less representative of a real browser than
 * Chrome's current headless mode, so it's removed here. `useStealth` is
 * now enabled by default (WHATSAPP_USE_STEALTH=false to disable) since
 * OpenWA's own docs note it helps with exactly this class of loading/
 * detection issue, with the tradeoff (per the same docs) that it can
 * occasionally cause an unrelated `browser.setMaxListeners` issue.
 */
export class OpenWAProvider implements WhatsAppProvider {
  private client: Client | null = null;
  private state: OpenWAConnectionState = "DISCONNECTED";
  // OpenWA's onStateChanged can fire several transitions within milliseconds of each other (e.g.
  // OPENING -> PAIRING -> CONNECTED), and each call site below fires setState() without awaiting
  // it. Without this chain, two of recordConnectionState()'s DB writes for the SAME account could
  // resolve out of order — whichever round-trip happens to finish last wins, regardless of which
  // state change actually happened last — leaving a stale status (e.g. "RECONNECTING") persisted
  // even though the session is really CONNECTED. Chaining onto this promise instead of calling
  // recordConnectionState directly guarantees writes for this instance commit in the same order
  // the state changes actually occurred, no matter how their individual DB round-trips interleave.
  private pendingStateWrite: Promise<void> = Promise.resolve();

  constructor(
    private readonly accountId: string,
    private readonly sessionId: string,
    private readonly sessionDataPath: string,
  ) {}

  async connect(): Promise<void> {
    process.chdir(this.sessionDataPath);
    await this.clearStaleChromiumLock();
    await this.setState("STARTING");

    ev.on("qr.**", (qrCode: string, sessionId: string) => {
      if (sessionId !== this.sessionId) return;
      this.setState("QR_AVAILABLE", { qrLength: qrCode.length }, qrCode).catch(() => undefined);
    });

    const useStealth = process.env.WHATSAPP_USE_STEALTH !== "false";

    await this.setState("WAITING_FOR_QR");

    // Confirmed live in production logs: OpenWA's internal session-detection can get wedged after
    // an unscanned QR — it logs "Session most likely logged out" to its own console output (not
    // ours) and then never resolves OR rejects create()'s promise. Neither `qrTimeout: 0` nor
    // `authTimeout: 120` below protect against this specific failure mode — they bound the
    // library's *internal* races, not the outer promise we're awaiting, so a wedge here hung
    // forever with zero signal: no error, no retry (connectWithRetry never saw a rejection to act
    // on), and the account sat on an increasingly stale QR indefinitely. This watchdog is a bound
    // on OUR wait only, generous enough to never cut off a real (if slow) human scan — it exists
    // purely to convert "hung forever, silently" into "fails after a long-but-finite wait", which
    // connectWithRetry can then actually retry.
    const watchdogMs = Number(process.env.WHATSAPP_CONNECT_WATCHDOG_MS) || 10 * 60_000;
    let watchdogTimer: NodeJS.Timeout | undefined;
    const watchdog = new Promise<never>((_, reject) => {
      watchdogTimer = setTimeout(
        () => reject(new Error(`OpenWA connection attempt did not settle within ${watchdogMs}ms — treating as stalled.`)),
        watchdogMs,
      );
    });

    try {
      this.client = await Promise.race([
        create({
          sessionId: this.sessionId,
          sessionDataPath: this.sessionDataPath,
          multiDevice: true,
          // PHASE 5.1.1 — confirmed via reading initializer.js: `customUserAgent`
          // below is silently ignored without this flag. OpenWA only copies
          // `config.customUserAgent` into the variable it actually passes to
          // `page.setUserAgent()` inside an `if (config.inDocker)` block — every
          // previous run (verified via a live PAGE_UA readout showing the
          // hardcoded Chrome/104 default even after this override was added)
          // silently fell through to that default because this flag was never
          // set, regardless of what customUserAgent was configured to.
          inDocker: true,
          // PHASE 5.1 — root cause found via a live CDP screenshot of the
          // actual stuck page (see final report): it was never a QR/canvas
          // problem at all. WhatsApp Web was serving "WhatsApp works with
          // Google Chrome 100+ — please update your browser", because
          // OpenWA's hardcoded default customUserAgent claims
          // `Chrome/104.0.0.0` (config/puppeteer.config.js), which current
          // WhatsApp Web now rejects — even though the real installed
          // Chromium is v151. With no QR ever rendered, every downstream
          // wait (needsToScan's canvas selector, isInsideChat, the whole
          // authRace) was doomed regardless of timeouts or selectors.
          // Overriding it to match the ACTUAL installed Chromium's major
          // version keeps the legacy UA string consistent with the User-
          // Agent Client Hints Chromium derives from the real engine
          // (spoofing only the legacy string while leaving Client Hints at
          // the true version is itself a mismatch WhatsApp could flag).
          customUserAgent:
            process.env.WHATSAPP_CUSTOM_USER_AGENT ??
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
          // Deliberately NOT setting `headless` here (see class doc comment):
          // omitting it lets the library's own internal `headless: "new"`
          // default survive. OpenWA's ConfigObject type only declares
          // `headless?: boolean`, but the runtime accepts puppeteer's
          // `"new"` — since the type doesn't allow that string, and setting
          // `headless: true` was the actual bug (it overrides "new" via
          // object-spread order in browser.js), omission is the correct fix.
          useStealth,
          useChrome: false,
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
          qrTimeout: 0, // wait indefinitely for a human to scan — this one is intentional
          // PHASE 5.1: authTimeout: 0 was a real bug, not a safe "wait forever"
          // choice. It doesn't just skip a deadline for the human — it disables
          // the ONLY timeout wrapped around OpenWA's internal
          // Promise.race([needsToScan, isInsideChat, sessionDataInvalid]) used
          // to detect page state (auth.js). Each of those three race members
          // has its own hardcoded `timeout: 0` (infinite) in the library, so
          // with authTimeout also at 0, a page whose QR canvas doesn't match
          // the library's expected selector hangs forever with zero
          // diagnostic signal. Any non-zero value here selects a 120s bound
          // (multiDevice is true) instead of the true value passed — an
          // upstream quirk, not something this value can fine-tune further.
          authTimeout: 120,
          popup: false,
          cacheEnabled: false,
        }),
        watchdog,
      ]);
    } catch (err) {
      // Do not silently swallow: full error, with stack, goes to both the
      // console (docker logs) and SystemLog (dashboard).
      await this.setState("ERROR", { error: (err as Error).message, stack: (err as Error).stack });
      throw err;
    } finally {
      clearTimeout(watchdogTimer);
    }

    // create() only resolves after a successful scan+auth — OpenWA's public
    // API has no earlier observable boundary between "QR scanned" and
    // "fully connected" (see class doc comment), so these are logged
    // back-to-back rather than claiming a false level of granularity.
    await this.setState("AUTHENTICATING");
    await this.setState("CONNECTED");

    // PHASE 5.2: only reached once `create()` has actually resolved — i.e.
    // genuinely authenticated, never before/during the QR wait. Failure here
    // must never take down a WhatsApp session that is otherwise live and
    // working, so it's fully isolated: getAccountInfo() already swallows its
    // own errors (returns nulls), and this catch covers everything else.
    try {
      const info = await this.getAccountInfo();
      await recordAccountMetadata(this.accountId, info);
    } catch (err) {
      console.warn("[openwa] failed to retrieve account metadata after connecting — continuing without it", err);
    }

    await this.client.onStateChanged((libraryState) => {
      this.setState(mapLibraryState(libraryState), { libraryState }).catch((err) =>
        console.error("[openwa] failed to record state change", err),
      );
    });
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.kill();
      this.client = null;
    }
    await this.setState("DISCONNECTED");
  }

  /**
   * OpenWA's own doc comment on `logout()` warns it "can exit the whole process depending on your
   * config" — a real risk, not a hypothetical one, given the WAPI in-page call this makes. Given
   * that, this deliberately swallows errors rather than propagating them: whether or not the
   * remote unlink call fully completes, we still want to locally tear down and land on
   * DISCONNECTED so a fresh QR becomes available — the same outcome RECONNECT can't guarantee
   * (it reuses session data on purpose), but LOGOUT's entire point is to invalidate it.
   */
  async logout(): Promise<void> {
    if (this.client) {
      try {
        await this.client.logout(false); // false = do invalidate persisted session data
      } catch (err) {
        console.error("[openwa] logout() call failed — still tearing down the local session", err);
      }
      this.client = null;
    }
    await this.setState("DISCONNECTED");
  }

  getConnectionStatus(): ConnectionStatus {
    return toInterfaceStatus(this.state);
  }

  async getGroups(): Promise<GroupInfo[]> {
    if (!this.client) return [];
    const chats = await this.client.getAllGroups();
    return chats.map((chat) => ({
      whatsappGroupId: chat.id,
      name: chat.name || chat.formattedTitle || chat.id,
    }));
  }

  subscribeToMessages(handler: (message: RawIncomingMessage) => void): void {
    if (!this.client) throw new Error("OpenWAProvider: cannot subscribe before connect().");
    this.client.onAnyMessage((message) => {
      handler(toRawIncomingMessage(this.accountId, message));
    });
  }

  async sendMessage(chatId: string, body: string): Promise<SendResult> {
    if (!this.client) return { success: false, error: "Provider is not connected." };
    try {
      // ChatId is a branded template-literal string type; a plain runtime
      // string (from our DB) is structurally valid but needs an explicit
      // cast to satisfy the literal-pattern check.
      const result = await this.client.sendText(chatId as ChatId, body as Content);
      return {
        success: Boolean(result),
        providerMessageId: typeof result === "string" ? result : undefined,
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async getAccountInfo(): Promise<AccountInfo> {
    if (!this.client) return { phoneNumber: null, pushName: null };
    const [phoneNumber, me] = await Promise.all([
      this.client.getHostNumber().catch(() => null),
      this.client.getMe().catch(() => null),
    ]);
    return { phoneNumber, pushName: me?.pushname ?? null };
  }

  /**
   * `getChatById` is a single-chat store lookup (cheap), unlike
   * `getAllGroups()` which scans every chat and is documented elsewhere in
   * this file as too slow to run more than occasionally. A chat still being
   * present in the client's own chat store is the best available signal
   * OpenWA exposes for "are we still in this group" short of a full rescan.
   */
  async verifyGroupMembership(chatId: string): Promise<boolean> {
    if (!this.client) return false;
    try {
      // getChatById's typings only declare ContactId (a 1:1 chat id), but it works for any ChatId at
      // runtime — a group id is structurally a valid ChatId, just not this specific narrower alias.
      const chat = await this.client.getChatById(chatId as unknown as ContactId);
      return Boolean(chat && chat.isGroup !== false);
    } catch {
      return false;
    }
  }

  /** Single-group lookup only — see WhatsAppProvider.ts's doc comment for why this stays out of getGroups(). */
  async getGroupParticipantCount(chatId: string): Promise<number | null> {
    if (!this.client) return null;
    try {
      const members = await this.client.getGroupMembersId(chatId as GroupChatId);
      return Array.isArray(members) ? members.length : null;
    } catch {
      return null;
    }
  }

  /**
   * `addParticipant`'s declared return type is a strict `boolean`, but its
   * own doc comment (Client.d.ts) says it actually returns a string status
   * code on failure (`NOT_A_GROUP_CHAT`, `GROUP_DOES_NOT_EXIST`,
   * `NOT_A_CONTACT`, `INSUFFICIENT_PERMISSIONS`) — unlike `sendText`'s
   * `string = success id` convention, here a string means failure, so
   * `Boolean(result)` would wrongly report success for any non-empty
   * status string. Only a literal `true` counts as success.
   */
  async addGroupParticipant(chatId: string, phoneNumber: string): Promise<SendResult> {
    if (!this.client) return { success: false, error: "Provider is not connected." };
    try {
      // The declared return type is a strict `boolean`, but the library's own doc comment says it
      // actually returns a string status code on failure — cast to the true runtime union.
      const result = (await this.client.addParticipant(
        chatId as GroupChatId,
        `${phoneNumber}@c.us` as ContactId,
      )) as boolean | string;
      if (result === true) return { success: true };
      return { success: false, error: typeof result === "string" ? result : "Failed to add participant." };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  private async setState(
    state: OpenWAConnectionState,
    metadata?: Record<string, unknown>,
    qrCode?: string,
  ): Promise<void> {
    this.state = state;
    this.pendingStateWrite = this.pendingStateWrite.then(() =>
      recordConnectionState(this.accountId, state, metadata, qrCode),
    );
    await this.pendingStateWrite;
  }

  /**
   * PHASE 5.1: found via direct inspection of the whatsapp_session volume
   * after a "Failed to launch the browser process!" failure — Chromium
   * leaves a `SingletonLock` (plus SingletonCookie/SingletonSocket) in its
   * user-data-dir, and refuses to launch a new instance against a profile
   * that still has one, even though the process that created it is long
   * dead. This happens whenever the container is stopped without Chromium
   * getting a clean shutdown (SIGKILL after Docker's stop grace period,
   * `docker compose down`, a host crash, etc.) — an ungraceful stop is the
   * normal case to plan for, not an edge case. Our architecture guarantees
   * at most one Chromium instance ever runs against this profile (one
   * worker, one OpenWA instance) — see ARCHITECTURE.md's single-session-
   * per-worker note — so on startup any pre-existing lock is provably
   * stale and safe to remove before every connection attempt.
   */
  private async clearStaleChromiumLock(): Promise<void> {
    const profileDir = join(this.sessionDataPath, `_IGNORE_${this.sessionId}`);
    const lockFiles = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
    for (const file of lockFiles) {
      await rm(join(profileDir, file), { force: true }).catch(() => undefined);
    }
  }
}
