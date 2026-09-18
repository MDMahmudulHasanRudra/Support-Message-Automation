import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  create,
  ev,
  MessageTypes,
  STATE,
  type ChatId,
  type Client,
  type ContactId,
  type Content,
  type DataURL,
  type GroupChatId,
  type Message as WaMessage,
  type MessageId,
} from "@open-wa/wa-automate";
import type { RawIncomingMessage } from "../../pipeline/types.js";
import type {
  AccountInfo,
  CollectionProbe,
  ConnectionStatus,
  GroupCreationResult,
  GroupInfo,
  GroupJoinResult,
  GroupParticipant,
  ProfileUpdate,
  ProfileUpdateResult,
  SendResult,
  WhatsAppProvider,
} from "../WhatsAppProvider.js";
import {
  readPairingPreference,
  readProxyConfig,
  recordAccountMetadata,
  recordConnectionState,
  type OpenWAConnectionState,
} from "./connectionState.js";
import { serializeMessageId } from "./messageId.js";
import { withTimeout } from "../../util/withTimeout.js";

/**
 * Ceilings on the two teardown calls into Chromium, neither of which had one.
 *
 * Both are held by an overlap-guarded loop — the registry sync and the strictly-serial command
 * processor — so a call that never settles does not fail, it silently stops that loop forever.
 * Generous enough that a merely slow browser still completes properly; short enough that a dead
 * one costs one tick rather than the process lifetime.
 */
const KILL_TIMEOUT_MS = 30_000;
const LOGOUT_TIMEOUT_MS = 30_000;

/**
 * Ceiling on the watchdog probe's chat enumeration.
 *
 * Shorter than the group sync's 150s deliberately: the sync is a job that can afford to take its
 * time, while this is a health check that runs inside an overlap-guarded loop and is supposed to
 * be cheap. Ninety seconds is long enough for a large roster on a good day and short enough that
 * a bad one costs one tick rather than three minutes.
 */
const PROBE_ENUMERATION_TIMEOUT_MS = Number(process.env.COLLECTION_PROBE_TIMEOUT_SECONDS || 90) * 1_000;

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
/**
 * For a `chat` message, open-wa's `body` is the actual text. For any media
 * type (image, video, document, ...), `body` instead holds a base64-encoded
 * thumbnail/media blob — never text — so it must never be stored/matched as
 * the message body. `caption`/`filename`/`loc` hold the actual human text.
 */
function resolveMessageBody(message: WaMessage): string {
  if (!message.isMedia) {
    return message.body ?? message.text ?? "";
  }

  const caption = message.caption?.trim();
  switch (message.type) {
    case MessageTypes.IMAGE:
      return caption ? `[Image] ${caption}` : "[Image]";
    case MessageTypes.VIDEO:
      return caption ? `[Video] ${caption}` : "[Video]";
    case MessageTypes.AUDIO:
      return "[Audio]";
    case MessageTypes.VOICE:
      return "[Voice message]";
    case MessageTypes.DOCUMENT:
      return message.filename ? `[Document] ${message.filename}` : "[Document]";
    case MessageTypes.STICKER:
      return "[Sticker]";
    case MessageTypes.LOCATION:
      return message.loc ? `[Location] ${message.loc}` : "[Location]";
    case MessageTypes.CONTACT_CARD:
    case MessageTypes.CONTACT_CARD_MULTI:
      return "[Contact card]";
    default:
      return caption ? `[Media] ${caption}` : "[Media]";
  }
}

/** "8801XXXXXXXXX@c.us" -> "8801XXXXXXXXX". Leaves an already-bare number untouched. */
function stripJidDomain(jid: string | null | undefined): string {
  return String(jid ?? "").split("@")[0] ?? "";
}

function toRawIncomingMessage(accountId: string, message: WaMessage): RawIncomingMessage {
  return {
    accountId,
    whatsappMessageId: message.id,
    chatId: message.chatId,
    whatsappGroupId: message.isGroupMsg ? message.chatId : null,
    // OpenWA hands these over as JIDs ("8801XXXXXXXXX@c.us"), not phone numbers. Everything
    // downstream compares this against InternalTeamMember.phoneNumber, which people type as
    // "+8801XXXXXXXXX" — so storing the JID verbatim meant no team member ever matched, and
    // their own messages were processed as if a customer had sent them. The mention list two
    // lines below has always split the domain off; this one was simply missed.
    senderPhone: stripJidDomain(message.isGroupMsg ? message.author || message.from : message.from),
    senderName: message.sender?.pushname || message.sender?.formattedName || null,
    direction: message.fromMe ? "OUTGOING" : "INCOMING",
    body: resolveMessageBody(message),
    timestampWa: new Date(message.timestamp * 1000),
    // Support Activity Tracking's REPLY_TO_CUSTOMER/MENTION triggers — both ride on this same
    // onAnyMessage payload, no separate subscription needed.
    // Normalised rather than read raw: the history API behind the missed-message catch-up returns
    // this as WhatsApp's key object, not the string the live listener gets — see messageId.ts.
    quotedWhatsappMessageId: message.isQuotedMsgAvailable ? serializeMessageId(message.quotedMsg?.id) : null,
    mentionedPhones: (message.mentionedJidList ?? []).map((jid) => String(jid).split("@")[0] ?? "").filter(Boolean),
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
/**
 * Thrown to unwind a connection attempt that an operator has replaced with a differently
 * configured one. Matched by message rather than by class because it only ever travels from
 * `disconnect()` to the `catch` inside `openSession()` a few lines away, and a dedicated Error
 * subclass for a two-call-site signal is more machinery than the signal is worth.
 */
const ABANDONED = "OPENWA_ATTEMPT_ABANDONED";

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

  // The message listener is held on the INSTANCE, not on the client, because `connect()` builds a
  // brand-new `Client` every time and a listener attached to the previous one dies with it. This
  // was a real silent failure: RECONNECT (disconnect + connect) left the account CONNECTED, green
  // on the dashboard, sends working — and `onAnyMessage` wired to a killed browser, so not one
  // further message was ever stored. Nothing reported it, because nothing arriving is
  // indistinguishable from a quiet afternoon.
  private messageHandler: ((message: RawIncomingMessage) => void) | null = null;
  // Which client the listener is currently attached to. Identity, not a boolean: it answers "is
  // THIS client wired up", so a re-attach after a reconnect happens and a second attach to the
  // same client (which would process every message twice) cannot.
  private listenerClient: Client | null = null;
  // The in-flight connect, if there is one. `connect()` launches Chromium and does a
  // process-global `process.chdir()` first; two overlapping attempts for the same account would
  // race each other exactly as two accounts connecting concurrently would. Now that a dropped
  // session is recovered automatically, there are two callers that can ask at once — the recovery
  // loop and an operator pressing Reconnect — so the guard belongs here rather than in an
  // agreement between them.
  private connecting: Promise<void> | null = null;

  /**
   * Releases the attempt above when it is waiting for a human who is never coming.
   *
   * `connect()` joining an attempt in flight is right for two callers wanting the SAME thing, and
   * wrong the moment somebody wants a different one. Switching an account from a QR to a phone
   * code is exactly that: the running attempt is parked inside `create()` waiting for a scan —
   * indefinitely, since `qrTimeout` is 0 — and `disconnect()` could not release it either, because
   * it only tears down `this.client`, which stays null until `create()` resolves. So the new
   * attempt joined the old one, the new config was never read, no link code was ever requested,
   * and the dialog waited for a code that could not arrive.
   *
   * Set for the life of one attempt and cleared with it, so an attempt that has already settled
   * cannot be abandoned retroactively.
   *
   * ONE HONEST COST. The browser an abandoned attempt launched cannot be killed: OpenWA hands back
   * a client only when `create()` RESOLVES, and the whole point here is that it has not. That
   * Chromium is orphaned until the worker restarts. Survivable, because `clearStaleChromiumLock()`
   * removes the profile's Singleton files at the start of every attempt — which is exactly what
   * lets the next one launch over it — and bounded, because this is reached by a person changing
   * how they want to link, never by a loop.
   */
  private abandonAttempt: ((reason: Error) => void) | null = null;

  constructor(
    private readonly accountId: string,
    private readonly sessionId: string,
    private readonly sessionDataPath: string,
  ) {}

  /** Joins an attempt already in progress rather than starting a second one. */
  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.openSession().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async openSession(): Promise<void> {
    // The directory has to exist before chdir, and nothing else guarantees it does.
    // accountProvisioning assigns every non-legacy account a path of `${SESSION_ROOT}/${id}`
    // but only records it — the folder itself was never created, so `process.chdir()` threw
    // ENOENT on all three connect attempts and the account could never produce a QR at all.
    // Only the legacy Primary account escaped it, because its path is the volume mount point,
    // which Docker creates. Recursive and idempotent, so an existing session is untouched.
    await mkdir(this.sessionDataPath, { recursive: true });
    process.chdir(this.sessionDataPath);
    await this.clearStaleChromiumLock();
    await this.setState("STARTING");

    // Both linking methods arrive HERE, on one event, and that is the library's design rather
    // than a coincidence worth defending against: `grabAndEmit` in its auth controller emits
    // `isLinkCode ? qrData : await page.evaluate('window.getQrPng()')`, so this callback receives a
    // `data:image/png` URL when a QR was rendered and a bare nine-character code ("ABCD-EFGH")
    // when one was requested by phone number. `pairingMethod` on the account row is what tells the
    // dashboard which of the two it is holding — length-sniffing the value would work today and
    // would be a guess about somebody else's format tomorrow.
    ev.on("qr.**", (qrCode: string, sessionId: string) => {
      if (sessionId !== this.sessionId) return;
      this.setState("QR_AVAILABLE", { qrLength: qrCode.length }, qrCode).catch(() => undefined);
    });

    const useStealth = process.env.WHATSAPP_USE_STEALTH !== "false";
    const pairing = await readPairingPreference(this.accountId);
    const proxy = await readProxyConfig(this.accountId);

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

    // The third racer: an operator deciding, mid-wait, that they want to link a different way.
    // Rejecting here is what lets `openSession` unwind and `connect()` clear `this.connecting`, so
    // the next attempt is a genuinely new one that re-reads the pairing preference.
    const abandoned = new Promise<never>((_, reject) => {
      this.abandonAttempt = reject;
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
          // Selects WhatsApp's "Link with phone number" flow instead of the QR. The library's
          // initializer races one or the other and never both —
          // `if (config?.linkCode) race.push(qrManager.linkCode(...)) else race.push(smartQr(...))`
          // — so this key is the whole switch between the two methods.
          //
          // The check is truthiness, so `linkCode: undefined` would in fact still take the QR
          // branch. Spread conditionally anyway: a key that must be absent-or-valid is worth
          // making absent, rather than relying on every future reader of this config treating an
          // undefined value the same way this one version of the library happens to.
          ...(pairing.method === "PHONE_CODE" ? { linkCode: pairing.linkCodeNumber } : {}),
          // Per-account proxy, read fresh above for the same reason the pairing preference is:
          // this config is built on every connect attempt, not just the operator-initiated one.
          // `corsFix: true` alongside it is the library's own documented mitigation for a proxy
          // causing CORS errors, and is harmless with no proxy configured.
          ...(proxy
            ? {
                // The library's own type declares `username`/`password` as required strings even
                // though its doc comment calls them optional — most proxies genuinely need no
                // credentials, so an unauthenticated proxy is represented here as empty strings
                // rather than widening the library's type.
                proxyServerCredentials: {
                  address: proxy.address,
                  protocol: proxy.protocol,
                  username: proxy.username ?? "",
                  password: proxy.password ?? "",
                },
                corsFix: true,
              }
            : {}),
        }),
        watchdog,
        abandoned,
      ]);
    } catch (err) {
      // An abandoned attempt is not a failure to report as one. It means an operator chose a
      // different way to link while this one was still waiting, and the attempt that replaces it
      // is already on its way — recording ERROR here would put a red badge on the account for the
      // few seconds until the new attempt sets its own state, and a SystemLog entry describing a
      // problem that nobody has.
      if ((err as Error).message === ABANDONED) {
        await this.setState("DISCONNECTED", { reason: "Superseded by a new connection attempt." });
        throw err;
      }
      // Do not silently swallow: full error, with stack, goes to both the
      // console (docker logs) and SystemLog (dashboard).
      await this.setState("ERROR", { error: (err as Error).message, stack: (err as Error).stack });
      throw err;
    } finally {
      clearTimeout(watchdogTimer);
      this.abandonAttempt = null;
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

    // Re-wire the message listener to the client we just built. This must live INSIDE connect()
    // rather than at the call site: every path that reconnects — the RECONNECT command, the
    // registry's automatic recovery, anything added later — goes through here, so none of them can
    // forget it. A no-op on the very first connect, where subscribeToMessages has not run yet and
    // attaches itself the moment it does.
    this.attachMessageListener();
  }

  async disconnect(): Promise<void> {
    // Release an attempt that is still WAITING before touching the client, because in that state
    // there is no client to touch: `create()` has not resolved, so `this.client` is null and the
    // old body of this method did nothing at all. The attempt stayed parked in `this.connecting`,
    // and the `connect()` that every caller pairs with `disconnect()` quietly joined it instead of
    // starting a new one — which is why changing an account's pairing method mid-QR never took.
    //
    // Awaited rather than fired and forgotten: `connect()` clears `this.connecting` in a `finally`,
    // so waiting for this to settle is what guarantees the caller's next `connect()` sees null and
    // genuinely starts over.
    const inFlight = this.connecting;
    if (inFlight) {
      this.abandonAttempt?.(new Error(ABANDONED));
      await inFlight.catch(() => undefined);
    }

    if (this.client) {
      // BOUNDED. `kill()` talks to a Chromium that may itself be the thing that has gone wrong,
      // and it carried no timeout at all — so a browser that never answered left this await
      // pending forever. Everything upstream is sequential and overlap-guarded: the registry sync
      // and the command processor both hold their own `processing` flag across the call, so one
      // unanswering kill() silenced that entire loop for the lifetime of the process, with a green
      // heartbeat and no log line to say so. The group sync already proves this pattern
      // (see `withTimeout` in commandProcessor.ts); this is the same treatment for the same shape.
      //
      // Giving up on the wait is safe here: the point of disconnect() is to stop USING this
      // client, and `this.client = null` below achieves that whether or not the browser ever
      // acknowledged. A leaked Chromium is a bounded, visible cost; a wedged loop is not.
      await withTimeout(this.client.kill(), KILL_TIMEOUT_MS).catch((err) => {
        console.error("[openwa] kill() did not settle in time — abandoning the browser and carrying on", err);
      });
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
        // Bounded for the same reason as kill() above, and with more cause: OpenWA's own doc
        // comment warns this call "can exit the whole process depending on your config". It runs
        // inside the strictly-serial command processor, so one that never returns takes every
        // subsequent dashboard action with it.
        await withTimeout(this.client.logout(false), LOGOUT_TIMEOUT_MS, "logout"); // false = do invalidate persisted session data
      } catch (err) {
        console.error("[openwa] logout() call failed or timed out — still tearing down the local session", err);
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

  /**
   * Records the handler and wires it to the live session, now and after every future reconnect.
   *
   * Deliberately does NOT require a connected client: a handler registered before connect() is
   * attached by connect() itself. Refusing early registration would push the ordering back onto
   * every caller, which is how the listener came to be attached exactly once in the first place.
   */
  subscribeToMessages(handler: (message: RawIncomingMessage) => void): void {
    this.messageHandler = handler;
    this.attachMessageListener();
  }

  private attachMessageListener(): void {
    const handler = this.messageHandler;
    const client = this.client;
    if (!handler || !client) return;
    if (this.listenerClient === client) return; // already wired — a second onAnyMessage would double-process every message
    this.listenerClient = client;
    client.onAnyMessage((message) => {
      handler(toRawIncomingMessage(this.accountId, message));
    });
  }

  /**
   * Everything the browser still holds for chats touched since `since` — how a gap gets filled
   * after the worker was down, restarted, or reconnecting.
   *
   * Bounded by chat activity, not by the roster: `getAllGroups()` reports each chat's last
   * interaction, so a fifteen-minute gap reads the handful of groups that actually received
   * something rather than scanning all 1,848. `getAllMessagesInChat` returns what WhatsApp Web has
   * loaded rather than full history, which is the right amount — a gap this is any use for is
   * hours, not months.
   *
   * Never throws. This runs immediately after a session comes up, and a failure to fill a gap must
   * not take down the connection that is otherwise working.
   */
  async fetchMessagesSince(since: Date, limit: number): Promise<RawIncomingMessage[]> {
    const probe = await this.probeCollection(since, limit);
    // Forgiving on purpose, and unchanged: a catch-up sweep that could not read history has
    // recovered nothing, which is a weaker guarantee rather than a broken one. Only the watchdog
    // needs to tell that apart from "there was nothing to recover", and it asks via probeCollection.
    return probe.ok ? probe.messages : [];
  }

  /**
   * The same read, with its failures reported instead of swallowed.
   *
   * Three distinct outcomes, and the third is the one this exists for:
   *
   * - no client at all — the session object is gone, so nothing can be seen, and saying "no new
   *   messages" would be a lie in the most dangerous direction;
   * - the chat enumeration threw — the browser is there but not answering;
   * - the enumeration succeeded and returned **zero chats**. That looks like a successful read of
   *   an empty account, and for a number the watchdog has already established is in monitored
   *   groups it cannot be one. WhatsApp Web returning an empty roster is a statement about the
   *   page's state, not about the account, so it is `unknown` too.
   *
   * A failure to read ONE chat's history is not a failure of the probe — the other chats still
   * answered, which is what the question was.
   */
  async probeCollection(since: Date, limit: number): Promise<CollectionProbe> {
    if (!this.client) {
      return { ok: false, reason: "No live WhatsApp session in this process — nothing to ask." };
    }
    const sinceMs = since.getTime();
    const collected: RawIncomingMessage[] = [];

    let chats: Awaited<ReturnType<Client["getAllGroups"]>>;
    try {
      // Bounded by us, not by Puppeteer. `getAllGroups()` is the single most expensive call this
      // provider makes — on a roster of ~1,848 groups it has been observed exceeding the 150s
      // group-sync ceiling repeatedly (GROUP_SYNC_TIMEOUT in the live logs on 7, 11 and 18 Sep
      // 2026) — and without a bound of its own it runs until Puppeteer's 180s `protocolTimeout`
      // gives up. That is three minutes of a watchdog tick held open for a question that was
      // supposed to be cheap.
      chats = await withTimeout(this.client.getAllGroups(), PROBE_ENUMERATION_TIMEOUT_MS, "chat list");
    } catch (err) {
      const message = (err as Error).message || "unknown error";
      // Worded apart from a hard failure on purpose. "The session is dead" and "the chat list is
      // enormous and slow" both arrive here, and they need completely different responses — the
      // first is an outage, the second is this account's normal shape. An alert that confuses them
      // sends somebody to restart a worker that is fine.
      const timedOut = message.includes("timed out");
      console.warn("[openwa] could not enumerate chats — the session cannot be read", err);
      return {
        ok: false,
        reason: timedOut
          ? `The chat list took longer than ${Math.round(PROBE_ENUMERATION_TIMEOUT_MS / 1000)}s to read, so what WhatsApp is holding could not be checked. On a very large roster this can be normal; if it is constant, the group sync is likely timing out too.`
          : `Could not enumerate chats: ${message}`,
      };
    }

    if (chats.length === 0) {
      return { ok: false, reason: "WhatsApp returned no chats at all, which an account in groups cannot truly be." };
    }

    // `t` is seconds since the epoch of the chat's last interaction. A chat that has not been
    // touched since the gap began cannot be hiding a message from inside it.
    const active = chats.filter((chat) => typeof chat.t === "number" && chat.t * 1000 > sinceMs);

    for (const chat of active) {
      if (collected.length >= limit) break;
      try {
        // includeMe: our own replies are half of every conversation and the chat inbox reads
        // them. includeNotifications: false — "X joined the group" is not a customer message.
        const messages = await this.client.getAllMessagesInChat(chat.id as ChatId, true, false);
        for (const message of messages) {
          if (typeof message.timestamp !== "number" || message.timestamp * 1000 <= sinceMs) continue;
          collected.push(toRawIncomingMessage(this.accountId, message));
          if (collected.length >= limit) break;
        }
      } catch (err) {
        console.warn(`[openwa] could not read history for chat ${chat.id} — skipping it`, err);
      }
    }

    return { ok: true, messages: collected.sort((a, b) => a.timestampWa.getTime() - b.timestampWa.getTime()) };
  }

  async sendMessage(chatId: string, body: string, mentions?: string[]): Promise<SendResult> {
    if (!this.client) return { success: false, error: "Provider is not connected." };
    try {
      // ChatId is a branded template-literal string type; a plain runtime
      // string (from our DB) is structurally valid but needs an explicit
      // cast to satisfy the literal-pattern check.
      //
      // sendTextWithMentions only when there is actually someone to tag: it is a different
      // WhatsApp send path, and routing every ordinary reply through it to pass an empty array
      // would change the behaviour of every message in the product to serve one feature.
      // `hideTags: false` keeps the @name visible in the message — the whole point here is that a
      // person reading the group can see who is being asked.
      const result =
        mentions && mentions.length > 0
          ? await this.client.sendTextWithMentions(
              chatId as ChatId,
              body as Content,
              false,
              mentions as ContactId[],
            )
          : await this.client.sendText(chatId as ChatId, body as Content);
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
  async getGroupParticipants(chatId: string): Promise<GroupParticipant[]> {
    if (!this.client) return [];
    try {
      const members = await this.client.getGroupMembers(chatId as GroupChatId);
      if (!Array.isArray(members)) return [];
      return members
        .map((member) => ({
          phoneNumber: stripJidDomain(String(member.id)),
          // formattedName is often just the number back again; a real pushname is preferred
          // when the contact exposes one.
          name: member.pushname || member.formattedName || null,
          isSelf: Boolean(member.isMe),
        }))
        .filter((participant) => participant.phoneNumber.length > 0);
    } catch (err) {
      console.error(`[provider] could not read participants for ${chatId}`, err);
      return [];
    }
  }

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

  async reactToMessage(whatsappMessageId: string, emoji: string): Promise<SendResult> {
    if (!this.client) return { success: false, error: "Provider is not connected." };
    try {
      const ok = await this.client.react(whatsappMessageId as MessageId, emoji);
      return ok ? { success: true } : { success: false, error: "The reaction was not accepted." };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async editMessage(whatsappMessageId: string, newBody: string): Promise<SendResult> {
    if (!this.client) return { success: false, error: "Provider is not connected." };
    try {
      // The library's own doc comment marks this experimental: "most accounts do not have access
      // to this feature in their apps". A `false` result is therefore the expected outcome on many
      // accounts, not evidence of a defect — the caller surfaces it as an ordinary failure rather
      // than logging it as an error.
      const result = await this.client.editMessage(whatsappMessageId as MessageId, newBody as Content);
      if (result === false) {
        return { success: false, error: "This account cannot edit messages, or the message is too old to edit." };
      }
      return { success: true, providerMessageId: typeof result === "string" ? result : whatsappMessageId };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async createGroup(groupName: string, contactPhoneNumbers: string[]): Promise<GroupCreationResult> {
    if (!this.client) return { success: false, error: "Provider is not connected." };
    if (contactPhoneNumbers.length === 0) {
      // WhatsApp groups need at least one other member; a solo "group" is not a real request and
      // the library's own response for it is not worth relying on.
      return { success: false, error: "A group needs at least one member besides this account." };
    }
    try {
      const contacts = contactPhoneNumbers.map((digits) => `${digits}@c.us` as ContactId);
      const result = await this.client.createGroup(groupName, contacts.length === 1 ? contacts[0]! : contacts);
      // 200 is the library's own documented success code; anything else is a real failure
      // (a name WhatsApp rejected, a contact it could not add) rather than a network hiccup.
      if (result.status !== 200 || !result.gid) {
        return { success: false, error: `WhatsApp did not create the group (status ${result.status}).` };
      }
      return { success: true, whatsappGroupId: String(result.gid), name: groupName };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async joinGroupByInviteLink(inviteLink: string): Promise<GroupJoinResult> {
    if (!this.client) return { success: false, error: "Provider is not connected." };
    try {
      // The library's own doc comment: false means it did not work, 401 means this account was
      // previously removed from the group. Both are real outcomes worth reporting distinctly
      // rather than collapsing into one generic failure.
      const result = await this.client.joinGroupViaLink(inviteLink);
      if (result === false) return { success: false, error: "The invite link is invalid or has expired." };
      if (result === 401) return { success: false, error: "This account was previously removed from that group." };
      return { success: true, whatsappGroupId: String(result) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async updateProfile(update: ProfileUpdate): Promise<ProfileUpdateResult> {
    if (!this.client) return {};
    const result: ProfileUpdateResult = {};
    // Each field is its own try/catch and its own call: WhatsApp validates a display name, an
    // About text and a photo independently, so one being rejected (a name with disallowed
    // characters, say) must not also lose the other two fields the caller asked for.
    if (update.displayName !== undefined) {
      try {
        result.displayName = await this.client.setMyName(update.displayName);
      } catch {
        result.displayName = false;
      }
    }
    if (update.about !== undefined) {
      try {
        const ok = await this.client.setMyStatus(update.about);
        result.about = ok !== false;
      } catch {
        result.about = false;
      }
    }
    if (update.pictureDataUrl !== undefined) {
      try {
        result.pictureDataUrl = await this.client.setProfilePic(update.pictureDataUrl as DataURL);
      } catch {
        result.pictureDataUrl = false;
      }
    }
    return result;
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
