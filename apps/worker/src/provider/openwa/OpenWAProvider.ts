import { access, mkdir, rm } from "node:fs/promises";
import { toDataURL as renderQrDataUrl } from "qrcode";
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
  NumberCheckResult,
  ProfileUpdate,
  ProfileUpdateResult,
  SendResult,
  WhatsAppProvider,
} from "../WhatsAppProvider.js";
import { SessionNotReadyError } from "../WhatsAppProvider.js";
import {
  readPairingPreference,
  recordLinkWindow,
  readProxyConfig,
  recordAccountMetadata,
  recordConnectionState,
  type OpenWAConnectionState,
} from "./connectionState.js";
import { serializeMessageId } from "./messageId.js";
import { withTimeout } from "../../util/withTimeout.js";
import { killBrowsersUsingProfile } from "./orphanBrowsers.js";

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
/**
 * The real reason an add failed, which the library hides inside a thrown error.
 *
 * `addParticipant` does not return its failures. On a per-participant failure it throws an
 * `AddParticipantError` whose `.data` maps each contact id to a numeric status — 409 already in
 * the group, 403 blocked by that person's "who can add me" privacy setting, 408 recently left,
 * 500 group full — while the error's own `message` is the useless literal
 * "Unable to add some participants".
 *
 * Reading only `err.message`, as this file did, collapsed all four into one indistinguishable
 * string. "Already in the group" and "their privacy settings refuse you" call for opposite
 * responses — the first is a no-op to record, the second needs an invite link — so the code is
 * pulled out and returned in a form `describeAddFailure` can map.
 */
const ADD_PARTICIPANT_STATUS: Record<number, string> = {
  409: "ALREADY_IN_GROUP",
  403: "PRIVACY_SETTINGS",
  408: "RECENTLY_LEFT",
  500: "GROUP_FULL",
};

function readAddParticipantError(err: unknown): string {
  const data = (err as { data?: Record<string, number> })?.data;
  if (data && typeof data === "object") {
    // One id per call, so the first entry is this participant's own verdict.
    const status = Object.values(data)[0];
    if (typeof status === "number") return ADD_PARTICIPANT_STATUS[status] ?? `ADD_FAILED_${status}`;
  }
  return (err as Error)?.message ?? "Failed to add participant.";
}

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

/**
 * The exact messages `@open-wa/wa-automate` 4.76.0 emits on `STARTUP.<sessionId>` at the moment a
 * pairing is accepted. Exact strings, matched whole — see the listener that reads them for why
 * this is a deliberate trade rather than an oversight.
 *
 * The first comes from `QrManager.smartQr` and is a genuine QR scan. The second comes from
 * `initializer.js`'s `if (authenticated)` branch and is a session restored from stored data, where
 * nobody scanned anything — the stage is equally true there, and CONNECTED follows within seconds.
 *
 * There is deliberately no entry for the phone-link-code path: `QrManager.linkCode` announces the
 * code and then simply awaits `isInsideChat`, emitting nothing when the code is accepted. Inventing
 * an entry for it would put a "Code accepted" panel on screen at a moment nothing has confirmed,
 * which is the one mistake here that would send somebody away from a screen they still need.
 */
/** One group as `listGroupChats()` returns it — only what the sync and the collection probe read. */
interface LeanGroupChat {
  id: string;
  name: string | null;
  formattedTitle: string | null;
  /** Seconds since the epoch of the chat's last interaction, as WhatsApp Web records it. */
  t: number | null;
}

const ACCEPTED_STARTUP_MESSAGES = new Set([
  "QR code scanned. Loading session...",
  "Authenticated",
]);


/**
 * The library's own bound on `phoneIsOutOfReach`, which it races AFTER `authTimeout` expires,
 * before finally throwing. Not configured by us — its default, restated here because the deadline
 * below has to clear it and a number you cannot see is a number you cannot reason about.
 */
const LIBRARY_OUT_OF_REACH_TIMEOUT_SECONDS = 60;

/**
 * The library's authentication race, in seconds — as it BEHAVES, not as configured. The value
 * passed as `authTimeout` in the create() config below cannot change this; see the comment there.
 */
const LIBRARY_EFFECTIVE_AUTH_TIMEOUT_SECONDS = 120;

/**
 * Consecutive codeless attempts before the Chromium profile is treated as the cause. See
 * `shouldResetProfile()` for why it is not one.
 */
const CODELESS_FAILURES_BEFORE_PROFILE_RESET = 2;

/**
 * The first-code deadline, and the rule it has to obey:
 *
 *     firstCode > authTimeout + oorTimeout
 *
 * because everything on the left of that sum is the library legitimately still working. Those are
 * the library's EFFECTIVE values — 120 + 60 = 180s — not whatever is passed to it, and assuming
 * they were the same is what made the previous version of this comment wrong. 300s clears 180s
 * with two minutes of margin for the browser launch and page load that precede it.
 */
const MIN_FIRST_CODE_TIMEOUT_MS = 240_000;

/**
 * How long one linking attempt waits for somebody to scan — the window the dialog counts down.
 *
 * WhatsApp Web reissues the QR about every twenty seconds and nothing here can change that, so the
 * code on screen is always fresh; what runs out is this. Five minutes because that is what was
 * asked for, and it is still far more than a person standing at the phone needs. When it runs out
 * unscanned the attempt ends as QR_EXPIRED and `connectWithRetry` starts a new one — a new window,
 * a new code — without anybody pressing anything.
 *
 * It was ten minutes, which was generous for a scan and slow for everything else: this is also the
 * only thing that recovers an attempt wedged inside the library, so every extra minute here was a
 * minute of a stuck account before anything tried again.
 *
 * It must stay above MIN_FIRST_CODE_TIMEOUT_MS, or the generic "did not settle" error replaces the
 * specific "no code ever appeared" one — `connectTimeouts.test.ts` pins that.
 */
const LINK_WINDOW_MS = 300_000;

/**
 * What replaces the linking window the moment a scan is accepted.
 *
 * Without this a scan at 4:55 would be cut off by the window at 5:00, in the middle of the phone
 * syncing — killing a pairing that had already succeeded, and presenting it as time having run out.
 * From the scan onward the attempt is not waiting on a person, so the person's window stops
 * applying. It is replaced rather than cancelled because this is still the only bound on a wedged
 * `create()`: the library allows `authTimeout` + `oorTimeout` = 180s for the sync, and this clears
 * that by a minute.
 */
const POST_SCAN_GRACE_MS = 240_000;

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
   * The browser an abandoned attempt launched cannot be killed THROUGH THE LIBRARY: OpenWA hands
   * back a client only when `create()` RESOLVES, and the whole point here is that it has not. This
   * comment used to call the resulting orphan survivable "because this is reached by a person
   * changing how they want to link, never by a loop". That stopped being true the day the linking
   * window became five minutes: every unscanned window ends the same way, so orphans accumulated
   * in a loop, fought each retry for the profile, and kept publishing codes. They are now killed by
   * process, keyed on the profile directory — see `orphanBrowsers.ts`.
   */
  private abandonAttempt: ((reason: Error) => void) | null = null;

  /**
   * The QR and AUTH listeners are attached ONCE per provider, not once per attempt.
   *
   * They used to be registered inside `openSession()`, which runs on every connect — and `ev` is
   * the library's process-global emitter with no removal anywhere here, so a number that had
   * reconnected twenty times held twenty live handlers, each writing the same code to the same row
   * on every rotation. WhatsApp reissues roughly every twenty seconds, so that is twenty redundant
   * writes a minute, growing for the lifetime of the process, plus EventEmitter2's own
   * max-listener warning once it passes ten.
   */
  private sessionListenersAttached = false;

  /** Which linking method THIS attempt asked for — the two events mean different things per mode. */
  private pairingMode: "QR_CODE" | "PHONE_CODE" = "QR_CODE";

  /** The raw payload we last rendered ourselves, so the library's own image stays a fallback. */
  private renderedQrPayload: string | null = null;

  /**
   * Whether THIS attempt got as far as something an operator could act on — a code on screen, or
   * an accepted pairing. Reset per attempt; the only input to the profile reset below.
   */
  private attemptReachedLinkingScreen = false;

  /**
   * Consecutive attempts that never reached the linking screen at all.
   *
   * This exists because of a failure observed end to end on 23 Sep 2026, and the shape of it
   * matters more than the count. A Chromium profile left in a HALF-AUTHENTICATED state — enough
   * WhatsApp storage to look signed in, not enough to be — makes the library's own
   * `isAuthenticated()` race neither succeed nor fail: it burns the full `authTimeout`, kills the
   * browser, and produces NO QR AT ALL. Every retry then reuses the same profile and hits the same
   * wall, so the account cannot produce a code ever again. Three attempts were watched doing
   * exactly this, ~2.5 minutes each; only deleting the directory by hand broke it.
   *
   * A retry that cannot change its own inputs is not a retry. See `shouldResetProfile()`.
   */
  private codelessFailures = 0;
  /**
   * Bumped once at the start of every `openSession()` call — the ownership token that stops a
   * finished attempt from writing over a newer one.
   *
   * This was a real, reproducible bug: `publishRenderedQr` renders the QR image with `await
   * renderQrDataUrl(...)`, which is not instant, and nothing re-checked whether the attempt it was
   * rendering FOR was still the current one by the time that render finished. If a new attempt
   * started in that gap — a retry, or an operator switching to the phone-number tab — its correct
   * code could be overwritten a moment later by the STALE attempt's image finishing its render, and
   * the dialog would show it, wrongly, as if it were current. What reached the screen was worse
   * than a wrong QR: the plain-text link-code panel rendered the raw `data:image/png;base64,…`
   * string one character per box, since it trusted whatever `qrCode` held.
   *
   * The listeners are attached once and outlive every attempt (see `sessionListenersAttached`), so this
   * cannot be a local variable in `openSession()` — every event handler reads it fresh at the
   * moment it actually writes, which is the only moment that matters.
   */
  private attemptGeneration = 0;
  /**
   * Called by whichever code path first publishes a code for the attempt in flight, to cancel the
   * "no code ever appeared" deadline below. Set per attempt, cleared when the attempt settles.
   */
  private cancelFirstCodeDeadline: (() => void) | null = null;
  /**
   * Replaces the linking window with the post-scan grace period. Set per attempt, called at most
   * once — the moment WhatsApp accepts the scan — and cleared when the attempt settles.
   */
  private extendAfterScan: (() => void) | null = null;

  constructor(
    private readonly accountId: string,
    private readonly sessionId: string,
    private readonly sessionDataPath: string,
  ) {}

  /** Joins an attempt already in progress rather than starting a second one. */
  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.openSession()
      .then(() => {
        // Reached a live session, so whatever the profile held was usable after all.
        this.codelessFailures = 0;
      })
      .catch((err) => {
        // Only a CODELESS failure counts. An attempt that showed a code and then failed had a
        // working profile and a different problem — a phone that went out of reach, a sync that
        // timed out — and wiping the profile for that would force a re-scan over something a
        // retry can fix on its own.
        if (this.attemptReachedLinkingScreen) this.codelessFailures = 0;
        else this.codelessFailures += 1;
        throw err;
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  /**
   * Whether the Chromium profile is the prime suspect, and may be deleted before trying again.
   *
   * Both conditions are load-bearing.
   *
   * REPEATED CODELESS FAILURES is the symptom of a half-authenticated profile (see
   * `codelessFailures`). One is not enough — a browser that failed to launch, a page that did not
   * load, a transient network fault all fail codelessly too, and they fix themselves on the next
   * try. Waiting for the pattern costs one extra retry and buys not destroying a session over a
   * blip.
   *
   * NO SESSION DATA FILE is what makes this safe rather than merely effective. While
   * `<sessionId>.data.json` exists a restore is genuinely possible, and the profile is the thing
   * that would restore it — deleting it would turn a recoverable session into a mandatory re-scan,
   * which on an unattended worker at 3am means an account that stays down until somebody notices.
   * With no data file there is nothing to preserve: the profile is not restoring anything, it is
   * demonstrably not producing a code either, and a fresh directory is strictly better than the
   * one that has failed twice.
   */
  private async shouldResetProfile(): Promise<boolean> {
    if (this.codelessFailures < CODELESS_FAILURES_BEFORE_PROFILE_RESET) return false;
    const sessionDataFile = join(this.sessionDataPath, `${this.sessionId}.data.json`);
    try {
      await access(sessionDataFile);
      // A restore is still on the table. Leave it alone and let the retries keep trying.
      return false;
    } catch {
      return true;
    }
  }

  /**
   * Publishes whatever this attempt needs the operator to see, from the two events the library
   * raises for it.
   *
   * The library emits the SAME code twice under different namespaces (`grabAndEmit` in its auth
   * controller): the raw payload on `qrData.<session>` first, then, for a QR attempt, a rendered
   * `data:image/png` on `qr.<session>` — which it obtains by calling `window.getQrPng()` inside
   * the WhatsApp Web page. That image is WhatsApp's own canvas, and it is not black: it comes back
   * brand-coloured, which is what reached operators on screen. Red modules on white clear far less
   * contrast than a scanner expects, and the failure mode is the worst kind — it reads as a broken
   * camera or a dead session rather than a rendering problem.
   *
   * So a QR attempt is rendered HERE from the raw payload, black on white with a real quiet zone,
   * and the library's own image is kept only as a fallback for the case where our renderer throws.
   * A link-code attempt takes the other branch untouched: for it both events carry the bare
   * nine-character code rather than an image, and there is nothing to draw.
   *
   * Attached once per provider. See `sessionListenersAttached`.
   */
  private attachSessionListeners(): void {
    if (this.sessionListenersAttached) return;
    this.sessionListenersAttached = true;

    /**
     * Every event the library raises, printed, when `WHATSAPP_DEBUG_EVENTS=true`.
     *
     * Off by default and deliberately not clever: `ev` is an undocumented process-global bus whose
     * membership is set by whatever version of the library is installed, and the questions it
     * answers are the ones this module keeps producing — "did WhatsApp tell us anything at all, or
     * did we simply stop listening?". Working that out by reading `dist/` establishes what the
     * library COULD emit; only this establishes what it DOES, against the WhatsApp Web build
     * actually being served today.
     *
     * The QR payload is a tens-of-kilobytes data string reissued every twenty seconds, so it is
     * summarised rather than printed — the same reason `recordConnectionState` keeps it out of
     * SystemLog.
     */
    if (process.env.WHATSAPP_DEBUG_EVENTS === "true") {
      ev.on("**", (data: unknown, sessionId: string, namespace: string) => {
        const summary =
          typeof data === "string" ? (data.length > 60 ? `<${data.length} chars>` : data) : typeof data;
        console.log(`[openwa:ev] ${namespace}.${sessionId} ${summary}`);
      });
    }

    ev.on("qrData.**", (payload: string, sessionId: string) => {
      if (sessionId !== this.sessionId) return;
      if (this.pairingMode === "PHONE_CODE") return; // the code itself, handled below
      if (typeof payload !== "string" || !payload) return;
      // Captured NOW, not read again after the render — see attemptGeneration's own doc comment.
      void this.publishRenderedQr(payload, this.attemptGeneration);
    });

    ev.on("qr.**", (value: string, sessionId: string) => {
      if (sessionId !== this.sessionId) return;
      if (typeof value !== "string" || !value) return;
      const generation = this.attemptGeneration;
      // A link code is not an image — pass it through exactly as before.
      if (this.pairingMode === "PHONE_CODE") {
        // A code exists, so the attempt is now waiting on a person rather than stalled.
        this.cancelFirstCodeDeadline?.();
        this.writeQrState(generation, { qrLength: value.length }, value);
        return;
      }
      // Fallback only. If our own render already published this attempt's code, showing the
      // library's coloured image on top of it would undo the fix a moment later.
      if (this.renderedQrPayload) return;
      this.cancelFirstCodeDeadline?.();
      this.writeQrState(generation, { qrLength: value.length, rendered: false }, value);
    });

    /**
     * The moment WhatsApp accepts the scan.
     *
     * This is the one part of linking a person is actually watching, and until this listener
     * existed it was the only part the dashboard could say nothing about: the account's coarse
     * status reads RECONNECTING before the scan and RECONNECTING after it, so somebody who had
     * just held their phone up to the screen saw no change at all, and no way to tell a successful
     * scan from a dead code.
     *
     * WHY THIS EVENT, AND NOT THE STRUCTURED ONE. 4.76.0 also builds an `EvEmitter(sessionId,
     * 'AUTH')` in `dist/controllers/browser.js`, fired when the page requests
     * `_priority_components`. It is a boolean on a namespace of its own and it looked like the
     * obvious choice — so it was implemented first, and then it did not fire once against the
     * WhatsApp Web build being served (traced end to end with `WHATSAPP_DEBUG_EVENTS`, which
     * exists because of this). Reading `dist/` establishes what the library CAN emit; only a trace
     * establishes what it does. This is what it does, from `QrManager.smartQr`:
     *
     *     if (!gotResult && (qrData === 'QR_CODE_SUCCESS' || qrData === md)) {
     *       spinner?.succeed("QR code scanned. Loading session...");
     *
     * — the page's own `QR_CODE_SUCCESS` callback, surfaced only as the text of a terminal
     * spinner. `Spin` extends `EvEmitter`, so it reaches the same bus as `qr.**`.
     *
     * CONSUMING ANOTHER PACKAGE'S CONSOLE COPY IS A REAL COST, and it is accepted here on three
     * conditions. It is matched EXACTLY rather than by substring, so a reworded message stops
     * matching instead of matching the wrong thing — "Authenticating" and "Authenticated" differ
     * by two characters and mean opposite things. It is confined to this adapter, which is the
     * only file allowed to know what OpenWA is; everything above reads `connectionStage`. And
     * failure is degradation, not breakage: an unmatched message costs the accepted-scan panel and
     * nothing else, leaving exactly the behaviour that shipped before this — a code on screen
     * until CONNECTED arrives.
     *
     * GATED ON AN ATTEMPT BEING IN FLIGHT, and the reason is a correction to what this comment
     * used to say. It claimed the blast radius was cosmetic — "the stage reads AUTHENTICATED for a
     * moment, `status` is untouched". That was wrong. `setState` goes through
     * `recordConnectionState`, whose single update writes `status: toAccountStatus(state)`, and
     * AUTHENTICATED maps to RECONNECTING. So an orphan firing at an IDLE account would push it from
     * DISCONNECTED or ERROR — both of which `recoverIfDropped` retries — into RECONNECTING, which
     * it deliberately never retries. That is the absorbing state the 18 Sep 2026 outage was traced
     * to, reached by a stray event.
     *
     * It still cannot be generation-guarded: the handler runs synchronously at fire time, so
     * re-reading `attemptGeneration` inside it always yields the current one whichever attempt the
     * event came from, and the bus carries no attempt identity — only a session id, which is
     * per-provider and constant across attempts. An abandoned attempt's Chromium is now killed when
     * the attempt unwinds (see `orphanBrowsers.ts`), but a browser can still emit in the moment
     * before that kill lands, so the gate stays. `this.connecting`
     * is the honest substitute: it answers "does THIS provider have an attempt running right now",
     * which is the question that separates the damaging case from the harmless one. An orphan
     * arriving mid-attempt still lands, and that is fine — an attempt really is in progress.
     *
     * It never claims CONNECTED. The session still has to load, and `create()` resolving remains
     * the only thing that proves it can carry a message.
     */
    ev.on("STARTUP.**", (message: unknown, sessionId: string) => {
      if (sessionId !== this.sessionId) return;
      if (typeof message !== "string") return;
      if (!ACCEPTED_STARTUP_MESSAGES.has(message.trim())) return;
      // No attempt running here, so nothing this says can be about us. Before the deadline is
      // disarmed as well as before the write: an orphan must not cancel a live attempt's no-code
      // deadline either, which would leave only the ten-minute watchdog.
      if (!this.connecting) return;
      // An accepted scan is plainly not an attempt that failed to produce a code.
      this.attemptReachedLinkingScreen = true;
      this.cancelFirstCodeDeadline?.();
      // Nobody is being waited on any more, so the person's five minutes stop applying.
      this.extendAfterScan?.();
      // Never walk a live session backwards.
      if (this.state === "CONNECTED") return;
      this.setState("AUTHENTICATED").catch(() => undefined);
    });
  }

  /**
   * The one place any QR/code write actually reaches the database, so the generation check cannot
   * be forgotten at a call site the way three separate inline checks could be.
   *
   * These particular calls are synchronous with the event that produced them, so `generation`
   * can never actually be stale here — but writing through the same guarded path as the async
   * render below means nobody has to reason about which of the three sites needs the check and
   * which doesn't.
   */
  private writeQrState(generation: number, metadata: Record<string, unknown>, qrCode: string): void {
    if (generation !== this.attemptGeneration) return;
    // No attempt running, so no code can be ours to show. The generation check above cannot catch
    // this: an orphaned browser's events carry the same session id and arrive within the CURRENT
    // generation. Observed on 24 Sep 2026 — codes kept landing on the dashboard after every retry
    // had given up, each one linking a browser nothing was listening to. Same gate, and same
    // reasoning, as the STARTUP listener.
    if (!this.connecting) return;
    this.attemptReachedLinkingScreen = true;
    this.setState("QR_AVAILABLE", metadata, qrCode).catch(() => undefined);
  }

  /** Never throws: a failure here must leave the library's own image free to arrive instead. */
  private async publishRenderedQr(payload: string, generation: number): Promise<void> {
    try {
      const dataUrl = await renderQrDataUrl(payload, {
        errorCorrectionLevel: "M",
        // Four modules is the spec's quiet zone. Without it a scanner has no margin to lock onto
        // against whatever the dialog puts behind the image.
        margin: 4,
        scale: 8,
        color: { dark: "#000000ff", light: "#ffffffff" },
      });
      // The render just spent real time awaiting. A newer attempt — a retry, or an operator
      // switching methods — may have already begun and written its own, correct code; writing
      // this one now would silently replace it with an image belonging to an attempt that no
      // longer exists. This is the check whose absence produced the exact bug described above
      // attemptGeneration's declaration.
      if (generation !== this.attemptGeneration) return;
      this.renderedQrPayload = payload;
      // A scannable code is on screen: the attempt is waiting on a human now, not stalled, so the
      // short no-code deadline gives way to the generous human-scan watchdog.
      this.cancelFirstCodeDeadline?.();
      this.writeQrState(generation, { qrLength: dataUrl.length, rendered: true }, dataUrl);
    } catch (err) {
      console.error("[provider] could not render a QR code; falling back to the library's own image", err);
    }
  }

  private async openSession(): Promise<void> {
    // A new attempt begins: anything an OLDER attempt still has in flight (specifically, an
    // in-progress QR render — see attemptGeneration's own doc comment) must not be allowed to
    // write over what THIS attempt produces.
    this.attemptGeneration += 1;
    const generation = this.attemptGeneration;
    this.attemptReachedLinkingScreen = false;

    // Before anything is launched, because the profile directory is what gets launched AGAINST.
    if (await this.shouldResetProfile()) {
      console.warn(
        `[openwa] ${this.codelessFailures} attempts in a row reached no code and no session data remains — removing the profile so this one starts clean`,
      );
      await this.removeSessionProfile();
      this.codelessFailures = 0;
    }

    // The directory has to exist before chdir, and nothing else guarantees it does.
    // accountProvisioning assigns every non-legacy account a path of `${SESSION_ROOT}/${id}`
    // but only records it — the folder itself was never created, so `process.chdir()` threw
    // ENOENT on all three connect attempts and the account could never produce a QR at all.
    // Only the legacy Primary account escaped it, because its path is the volume mount point,
    // which Docker creates. Recursive and idempotent, so an existing session is untouched.
    await mkdir(this.sessionDataPath, { recursive: true });
    process.chdir(this.sessionDataPath);
    // Before the lock files go, never after: removing them is what lets a second Chromium start
    // against a profile a live one still holds, and two browsers on one profile is the failure
    // `killBrowsersUsingProfile` exists to prevent. Covers every way the last attempt could have
    // ended, including a worker path that never reached the catch below.
    await this.killOrphanedBrowsers("before launching");
    await this.clearStaleChromiumLock();
    await this.setState("STARTING");

    const useStealth = process.env.WHATSAPP_USE_STEALTH !== "false";
    const pairing = await readPairingPreference(this.accountId);
    this.pairingMode = pairing.method;
    this.renderedQrPayload = null;
    this.attachSessionListeners();
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
    const watchdogMs = Number(process.env.WHATSAPP_CONNECT_WATCHDOG_MS) || LINK_WINDOW_MS;
    let watchdogTimer: NodeJS.Timeout | undefined;
    // Set only by the LINKING-window timer, never by the post-scan one that may replace it, so the
    // catch below can tell "nobody scanned in time" from "the attempt wedged".
    let linkWindowExpired = false;
    let rejectWatchdog: (reason: Error) => void = () => undefined;
    const watchdog = new Promise<never>((_, reject) => {
      rejectWatchdog = reject;
      watchdogTimer = setTimeout(() => {
        linkWindowExpired = true;
        reject(new Error(`No scan within the ${Math.round(watchdogMs / 1000)}s linking window — starting a fresh one.`));
      }, watchdogMs);
    });
    this.extendAfterScan = () => {
      clearTimeout(watchdogTimer);
      watchdogTimer = setTimeout(
        () =>
          rejectWatchdog(
            new Error(
              `The scan was accepted but the session did not finish loading within ${Math.round(POST_SCAN_GRACE_MS / 1000)}s — treating as stalled.`,
            ),
          ),
        POST_SCAN_GRACE_MS,
      );
      this.extendAfterScan = null;
    };
    // The dashboard counts down to this. Chained onto the same write queue as every state change,
    // so it cannot land after — and undo — a transition that has already closed the window.
    const linkExpiresAt = new Date(Date.now() + watchdogMs);
    this.pendingStateWrite = this.pendingStateWrite.then(() => recordLinkWindow(this.accountId, linkExpiresAt));

    // The third racer: an operator deciding, mid-wait, that they want to link a different way.
    // Rejecting here is what lets `openSession` unwind and `connect()` clear `this.connecting`, so
    // the next attempt is a genuinely new one that re-reads the pairing preference.
    const abandoned = new Promise<never>((_, reject) => {
      this.abandonAttempt = reject;
    });

    /**
     * A fourth racer, for the failure the watchdog above is the wrong shape for.
     *
     * That watchdog is ten minutes because it is bounding a HUMAN: a code is on screen and
     * somebody has to walk to a phone and scan it. But it was also the only bound on a completely
     * different situation — an attempt that never produces a code at all, because the browser
     * failed to start, WhatsApp Web never loaded, or a network call before the QR screen hung.
     * Nothing is on screen in that case, so nobody is scanning anything, and waiting ten minutes
     * for a human who has nothing to look at is ten minutes of an operator pressing Connect and
     * watching a spinner.
     *
     * It is worse than slow, because the command processor is strictly serial: the stalled attempt
     * holds it, so every later Connect/Reconnect the operator tries sits PENDING behind the one
     * that is already never going to finish — which is exactly what "1 command waiting for the
     * worker" beside a stuck dialog means.
     *
     * So: a deadline on the FIRST code only, cancelled the moment one is published. After that the
     * generous human-scan bound takes over unchanged. Failing fast here is what lets
     * `connectWithRetry` actually retry, and releases the queue for the next command.
     *
     * THE DURATION IS NOT A TASTE JUDGEMENT — it is bounded from below by the library, and 150s
     * violated that bound. Before a code can appear the library runs its own `isAuthenticated()`
     * race for up to `authTimeout`, and on expiry races `phoneIsOutOfReach` for up to `oorTimeout`
     * before it throws. So the longest LEGITIMATE codeless window is those two added together —
     * 240s at the values now in force, where this deadline stood at 150. It was cutting in while
     * the library was still working, abandoning attempts it had no evidence against, and replacing
     * the library's accurate diagnosis ("App Offline", "Auth Timeout") with its own vaguer one.
     * `connectTimeouts.test.ts` asserts the ordering so the two cannot drift apart again.
     *
     * A reconnect with valid stored session data is the other caller: it emits no code at all and
     * restores straight to authenticated, so this races that too, and cutting a healthy restore
     * short would turn a working reconnect into a retry loop.
     *
     * Not longer than it needs to be either. This only ever fires when NOTHING has appeared, and
     * its entire job is to turn "wedged forever, silently" into something `connectWithRetry` can
     * act on — so every extra minute is a minute of an account not collecting before anything
     * tries again. The outer 10-minute watchdog already covers waiting on a human.
     */
    const firstCodeMs =
      Number(process.env.WHATSAPP_FIRST_CODE_TIMEOUT_MS) || MIN_FIRST_CODE_TIMEOUT_MS;
    let firstCodeTimer: NodeJS.Timeout | undefined;
    const firstCode = new Promise<never>((_, reject) => {
      firstCodeTimer = setTimeout(() => {
        reject(
          new Error(
            `No QR or link code appeared within ${Math.round(firstCodeMs / 1000)}s, and the session did not restore either — the attempt never reached WhatsApp's linking screen, so there was nothing to scan. Treating it as stalled so it can be retried.`,
          ),
        );
      }, firstCodeMs);
    });
    this.cancelFirstCodeDeadline = () => {
      clearTimeout(firstCodeTimer);
      this.cancelFirstCodeDeadline = null;
    };

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
          //
          // THAT LAST SENTENCE IS LOAD-BEARING AND WAS IGNORED ONCE, COSTING A WRONG FIX. On
          // 23 Sep 2026 a pairing that had already succeeded died two minutes later with
          // "Authentication timed out. Shutting down" -> "App Offline", so this was raised to 180
          // to give the phone longer to sync. It changed nothing. The library builds its timer as
          //
          //     timeout((config.authTimeout || config.multiDevice ? 120 : 60) * 1000)
          //
          // and `||` binds tighter than `?:`, so that reads `(authTimeout || multiDevice) ? 120 :
          // 60`. With multiDevice true, ANY truthy value here selects 120 seconds and the number
          // passed is discarded. The 180 shipped as an inert env knob and a test that asserted the
          // constant rather than the behaviour, so it passed while nothing had moved.
          //
          // The post-scan window is therefore 120s and cannot be widened from here. `0` is not an
          // escape hatch, for the reason above. What DOES help is `shouldResetProfile()`, which
          // recovers from the state this failure leaves behind rather than trying to prevent it.
          // `connectTimeouts.test.ts` now asserts the library's own expression, so a version that
          // fixes the precedence makes that test fail and this decision gets revisited.
          authTimeout: 120,
          popup: false,
          cacheEnabled: false,
          /**
           * Why a QR took so long to appear.
           *
           * Before showing a code, the library calls `getPatch()`, which does
           * `axios.get('https://raw.githubusercontent.com/.../patches.json')` — and on failure
           * retries the same host. That call carries **no timeout**, so axios falls back to the
           * OS TCP timeout: on a connection where GitHub is slow or filtered, the connect simply
           * sits there, and every second of it is spent before a QR can be rendered. From this
           * deployment's network that is the dominant cost of linking a number, not Chromium.
           *
           * `cachedPatch` changes the shape rather than the speed. With a cached copy present the
           * library returns it immediately and pushes the fresh download onto a background queue
           * (`queue.add(freshPatchFetchPromise)`) instead of awaiting it — so the QR appears at
           * once and the patches still refresh. The cache is written to `process.cwd()`, which
           * `openSession()` has already chdir'd to the account's own session directory, so it
           * lands on the persistent volume and survives restarts. It is ignored once a day old,
           * which is the library's own staleness bound, not ours.
           *
           * The first connect after a fresh volume still pays the download once. Everything after
           * it does not.
           */
          cachedPatch: true,
          /** One npm round trip per connect, for a number nothing here acts on. */
          skipUpdateCheck: true,
          /**
           * The library's own half of the logout fix, in its own words: "Deletes the session data
           * file (if found) on logout event. This results in a quicker login when you restart the
           * process."
           *
           * It fires on the logout EVENT, which needs a live client to emit one — so it cannot
           * reach the case `logout()` now handles by hand, where `create()` never resolved and
           * there is no client at all. The two are complementary rather than redundant: this
           * covers a clean logout from a working session, that covers the wedged one.
           */
          deleteSessionDataOnLogout: true,
          /**
           * Browser-side diagnostics, off unless asked for.
           *
           * When a connect never reaches the linking screen, everything explaining why happens
           * inside the page — and none of it reaches our logs, which is why that failure has been
           * so hard to tell apart from a slow network. These two surface it: console errors from
           * the page, and a screenshot of the browser at the moment `create()` fails.
           *
           * Both are gated because neither is free. WhatsApp Web throws benign console errors in
           * normal operation, so leaving the first on would bury real signal in noise; and the
           * screenshots are written into the session volume, which nothing prunes. Turn on with
           * WHATSAPP_DEBUG_BROWSER=true while diagnosing, off again afterwards.
           */
          ...(process.env.WHATSAPP_DEBUG_BROWSER === "true"
            ? { logConsoleErrors: true, screenshotOnInitializationBrowserError: true }
            : {}),
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
        firstCode,
      ]);
    } catch (err) {
      // `create()` did not resolve, so its browser belongs to nobody — and left alive it keeps
      // rotating codes onto the dashboard and holding the profile the next attempt needs. Killed
      // here rather than only at the next launch, because after the LAST retry there is no next
      // launch. Guarded on the generation so it can never reach a newer attempt's browser; in
      // practice none can exist yet, since `disconnect()` awaits this unwinding and retries are
      // sequential.
      if (generation === this.attemptGeneration) {
        await this.killOrphanedBrowsers("after an attempt that did not connect");
      }
      // An abandoned attempt is not a failure to report as one. It means an operator chose a
      // different way to link while this one was still waiting, and the attempt that replaces it
      // is already on its way — recording ERROR here would put a red badge on the account for the
      // few seconds until the new attempt sets its own state, and a SystemLog entry describing a
      // problem that nobody has.
      if ((err as Error).message === ABANDONED) {
        await this.setState("DISCONNECTED", { reason: "Superseded by a new connection attempt." });
        throw err;
      }
      // A code that sat on screen for the whole window without being scanned is not a failure of
      // anything — record it as what it is, so the dialog says "time ran out, fresh code coming"
      // instead of "something went wrong". `connectWithRetry` still sees the rejection and starts
      // the next attempt; only the description changes.
      if (linkWindowExpired && this.attemptReachedLinkingScreen) {
        await this.setState("QR_EXPIRED", { windowSeconds: Math.round(watchdogMs / 1000) });
        throw err;
      }
      // Do not silently swallow: full error, with stack, goes to both the
      // console (docker logs) and SystemLog (dashboard).
      await this.setState("ERROR", { error: (err as Error).message, stack: (err as Error).stack });
      throw err;
    } finally {
      clearTimeout(watchdogTimer);
      clearTimeout(firstCodeTimer);
      this.cancelFirstCodeDeadline = null;
      this.extendAfterScan = null;
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
    } else {
      // No client, and this is the case that mattered.
      //
      // `client.logout()` is what invalidated the stored session, so with no client this method
      // used to set a status and nothing else — the session on disk survived untouched. That is
      // precisely the state an operator reaches after a QR is shown and never scanned: `create()`
      // never resolved, so `this.client` is still null, while the profile it half-wrote stays
      // behind and wedges every following attempt. Logout was the one control that should have
      // cleared it, and it was the one control that could not.
      //
      // So do the invalidation ourselves. Removing the profile IS the logout here: the session is
      // not a small credentials file beside the profile, it is the profile — the whole Chromium
      // directory holding the cookies, local storage and IndexedDB that keep WhatsApp Web signed
      // in (verified against the mounted volume; see this class's own notes). Logout already
      // promises the next connect needs a fresh scan, so deleting it takes nothing a caller
      // expected to keep.
    }

    /**
     * ALWAYS, client or not — and the asymmetry this replaces cost a live account its ability to
     * link at all, observed end to end on 23 Sep 2026.
     *
     * Only the no-client branch above used to remove the profile. With a client we called
     * `client.logout(false)` and stopped, on the assumption that the library's own invalidation was
     * enough. It is not: it deletes `<sessionId>.data.json`, then tries to clear the Chromium
     * profile and FAILS, because the browser it is closing still holds files open —
     *
     *     ENOTEMPTY: directory not empty, rmdir
     *       '.../Default/IndexedDB/https_web.whatsapp.com_0.indexeddb.leveldb'
     *
     * — as an unhandled rejection, caught only by `installProcessGuards`, logged and otherwise
     * invisible. What survives is a half-authenticated profile, and that is fatal in a way nothing
     * about it announces: the next connect's `isAuthenticated()` race neither succeeds nor fails,
     * burns the whole `authTimeout`, kills the browser, and produces NO CODE. Every retry reuses
     * the same directory, so Logout followed by Connect was permanently broken — presenting as a
     * QR that simply never appears, which reads as "the QR is slow" and is nothing of the kind.
     *
     * After the client is gone rather than before, so this is not racing the browser for the same
     * files. `removeSessionProfile()` never throws, so it cannot stop the DISCONNECTED below.
     */
    await this.removeSessionProfile();
    await this.setState("DISCONNECTED");
  }

  /**
   * Deletes the Chromium profile that holds this session.
   *
   * Only ever called from `logout()` — never from `disconnect()`, which exists to drop a session
   * that is expected to be reusable immediately afterwards, and would turn a routine reconnect
   * into a forced re-scan.
   *
   * Never throws: a logout that cannot delete the folder must still land on DISCONNECTED, because
   * refusing to change state would leave the operator with no working control at all — which is
   * the situation this whole method exists to end.
   */
  private async removeSessionProfile(): Promise<void> {
    const profileDir = join(this.sessionDataPath, `_IGNORE_${this.sessionId}`);
    try {
      // `maxRetries` is exactly what ENOTEMPTY/EBUSY exists for, and this directory produces them
      // for real: Chromium writes into its own IndexedDB while it is being torn down, so a single
      // pass can delete a subtree and then find a file recreated underneath it. Node's default is
      // 0 retries, which is why the library's own attempt failed.
      await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      // The session IS the profile, but the data file is what the library reads first on the next
      // launch, and one describing a profile that no longer exists is its own kind of confusion.
      await rm(join(this.sessionDataPath, `${this.sessionId}.data.json`), {
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
      console.log(`[openwa] removed session profile at ${profileDir} — the next connect will ask for a fresh code`);
    } catch (err) {
      // Loud, because of what a survivor does. A profile left HALF-deleted rather than absent is
      // the exact state that stops this account producing a code at all, and the symptom people
      // report for it is "the QR does not work" — nothing points here. Naming the directory makes
      // the manual remedy obvious; `shouldResetProfile()` is what retries it without being asked.
      console.error(
        `[openwa] COULD NOT REMOVE THE SESSION PROFILE at ${profileDir}. A half-deleted profile stops this account producing a QR code at all — delete this directory with the worker stopped if linking keeps failing.`,
        err,
      );
    }
  }

  getConnectionStatus(): ConnectionStatus {
    return toInterfaceStatus(this.state);
  }

  async getGroups(): Promise<GroupInfo[]> {
    if (!this.client) return [];
    // A client object outlives its session: logging out on the phone reloads WhatsApp Web to its
    // login screen while `this.client` stays set, and the state listener records AUTH_FAILED
    // (UNPAIRED). Asking that page for groups crashes inside it, so say what is actually wrong.
    //
    // ONLY that state. DISCONNECTED is also where `mapLibraryState` files every library state it
    // does not recognise, and RECONNECTING is what OpenWA reports for a while right after a
    // successful connect — refusing either could stop a sync on a session that works, including
    // the post-connect one that fills in a freshly linked number. Every other dead page is caught
    // by evidence rather than by a label: `listGroupChats` finds no chat store in it.
    if (this.state === "AUTH_FAILED") {
      throw new SessionNotReadyError(
        "This account was logged out on the phone, so its groups cannot be read. Link it again from WhatsApp Accounts.",
      );
    }
    const chats = await this.listGroupChats();
    return chats.map((chat) => ({
      whatsappGroupId: chat.id,
      name: chat.name || chat.formattedTitle || chat.id,
    }));
  }

  /**
   * Every group on the account, as the four fields anything here reads — and why this is not
   * `client.getAllGroups()`.
   *
   * `getAllGroups()` is the call behind the group sync timing out in production (GROUP_SYNC_TIMEOUT
   * on 7, 11 and 18 Sep 2026; 736 groups locally already blew the 150s ceiling once). Its cost is
   * not the group count, it is what it does per chat. In the injected WAPI it is literally
   *
   *     getAllGroups = () => getAllChats().filter(chat => chat.isGroup)
   *     getAllChats  = () => Store.Chat.map(chat => _serializeChatObj(chat))
   *
   * so it fully serialises EVERY chat on the account — each one-to-one conversation as well — and
   * only then throws away everything that is not a group. And `_serializeChatObj` is heavy: the raw
   * model, the contact with its profile-picture thumbnail, presence, and the complete
   * `groupMetadata` including every participant. For ~1,848 groups that is the whole membership of
   * every group, serialised inside the page and shipped across the Puppeteer boundary as JSON, to
   * read two fields out of it.
   *
   * This runs one expression in the page instead: filter to groups FIRST, then return id, name,
   * formattedTitle and `t` — nothing else crosses the boundary. The values are taken from the same
   * places `_serializeChatObj` takes them (`toJSON()` for name and t, the model for formattedTitle,
   * `id._serialized` for the id), so what callers receive is the same data for those fields, not an
   * approximation of it.
   *
   * FALLS BACK TO `getAllGroups()`, and that is what makes it safe to ship without a live trace.
   * `window.Store` is WhatsApp Web's internal module registry, not a public API, and a build that
   * reshapes it would break this. Anything short of a non-empty list of string ids — a throw, a
   * missing Store, an empty result — takes the old path, so the worst case is exactly today's
   * behaviour rather than a group list quietly emptied. That also means a result of zero groups
   * never reaches `syncGroups` from here unless the slow path agrees, which matters because an
   * empty roster is the one input that sweep has been taught to distrust.
   *
   * EXCEPT when the chat store is missing altogether, which is not a shape change but a page with
   * no WhatsApp in it — logged out on the phone, reloaded to the login screen, not finished
   * loading. The slow path cannot help there: `getAllGroups()` is `Store.Chat.map(...)` on the very
   * same object, so falling back only moved the crash, and the operator got "Cannot read
   * properties of undefined (reading 'map')" from inside the page instead of the reason.
   */
  private async listGroupChats(): Promise<LeanGroupChat[]> {
    const client = this.client;
    if (!client) return [];
    try {
      const lean = await client.getPage().evaluate(() => {
        interface PageChat {
          isGroup?: boolean;
          id?: { _serialized?: string };
          formattedTitle?: string;
          toJSON?: () => { name?: string; t?: number };
        }
        const store = (globalThis as unknown as { Store?: { Chat?: { filter?: (fn: (chat: PageChat) => boolean) => PageChat[] } } })
          .Store;
        // Distinguished from `null` below on purpose: a missing store is the page having no
        // WhatsApp session in it, a store without `filter` is a WhatsApp Web build that reshaped it.
        if (!store?.Chat) return "NO_CHAT_STORE" as const;
        if (typeof store.Chat.filter !== "function") return null;
        return store.Chat.filter((chat) => Boolean(chat?.isGroup)).map((chat) => {
          const json = typeof chat.toJSON === "function" ? chat.toJSON() : {};
          return {
            id: chat.id?._serialized ?? null,
            name: typeof json.name === "string" ? json.name : null,
            formattedTitle: typeof chat.formattedTitle === "string" ? chat.formattedTitle : null,
            t: typeof json.t === "number" ? json.t : null,
          };
        });
      });
      if (lean === "NO_CHAT_STORE") {
        throw new SessionNotReadyError(
          "WhatsApp Web is not loaded in this account's session (it has no chat list), so its groups cannot be read. This usually means the number was logged out on the phone. Reconnect it from WhatsApp Accounts, and link it again if it asks for a QR code.",
        );
      }
      if (Array.isArray(lean) && lean.length > 0 && lean.every((chat) => typeof chat.id === "string")) {
        return lean as LeanGroupChat[];
      }
      console.warn("[openwa] lean group enumeration returned nothing usable — falling back to getAllGroups()");
    } catch (err) {
      if (err instanceof SessionNotReadyError) throw err;
      console.warn("[openwa] lean group enumeration failed — falling back to getAllGroups()", err);
    }
    const chats: unknown = await client.getAllGroups();
    // The library returns whatever the page evaluated to, which is not always a list — `false` under
    // some `onError` settings, `undefined` when the page produced nothing serialisable. Mapping over
    // either was the second way this crashed with a message about `map`.
    if (!Array.isArray(chats)) {
      throw new Error(
        `WhatsApp Web returned no group list (got ${chats === null ? "null" : typeof chats}). The session may still be loading — try the sync again in a minute, and reconnect the account if it keeps failing.`,
      );
    }
    return (chats as Awaited<ReturnType<typeof client.getAllGroups>>).map((chat) => ({
      id: chat.id,
      name: chat.name ?? null,
      formattedTitle: chat.formattedTitle ?? null,
      t: typeof chat.t === "number" ? chat.t : null,
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

    let chats: LeanGroupChat[];
    try {
      // Bounded by us, not by Puppeteer. `getAllGroups()` is the single most expensive call this
      // provider makes — on a roster of ~1,848 groups it has been observed exceeding the 150s
      // group-sync ceiling repeatedly (GROUP_SYNC_TIMEOUT in the live logs on 7, 11 and 18 Sep
      // 2026) — and without a bound of its own it runs until Puppeteer's 180s `protocolTimeout`
      // gives up. That is three minutes of a watchdog tick held open for a question that was
      // supposed to be cheap.
      chats = await withTimeout(this.listGroupChats(), PROBE_ENUMERATION_TIMEOUT_MS, "chat list");
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
        .map((member) => {
          const rawId = String(member.id ?? "");
          return {
            phoneNumber: stripJidDomain(rawId),
            // Carried through untouched. The domain is the only thing separating a real number
            // from a LID, and stripping it is exactly what makes the two impossible to tell apart
            // downstream — see GroupParticipant's own doc comment.
            rawId,
            // formattedName is often just the number back again; a real pushname is preferred
            // when the contact exposes one.
            name: member.pushname || member.formattedName || null,
            isSelf: Boolean(member.isMe),
            // getGroupMembers returns contacts, which carry no admin flag; getGroupAdmins is a
            // separate call. Null rather than false: this provider does not know, and saying
            // "not an admin" would be an answer we have not got.
            isAdmin: null,
          };
        })
        .filter((participant) => participant.rawId.length > 0);
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
      return { success: false, error: readAddParticipantError(err) };
    }
  }

  /**
   * One call for every group this account can add to.
   *
   * `iAmAdmin()` answers for the signed-in account directly, with no id comparison — which matters,
   * because comparing our own id against a roster runs straight into the LID problem this file
   * already has to work around elsewhere.
   */
  async getAdminGroupIds(): Promise<string[] | null> {
    if (!this.client) return null;
    try {
      const groups = await this.client.iAmAdmin();
      return Array.isArray(groups) ? groups.map((id) => String(id)) : null;
    } catch (err) {
      console.error("[provider] could not read admin groups", err);
      return null;
    }
  }

  async checkNumberOnWhatsApp(phoneNumber: string): Promise<NumberCheckResult> {
    if (!this.client) return { ok: false, reason: "Provider is not connected." };
    try {
      const result = await this.client.checkNumberStatus(`${phoneNumber}@c.us` as ContactId);
      // 200 means an account exists, 404 means it does not. Anything else is the library telling
      // us something we have no reading for, which is not the same as "no account".
      if (result?.status === 200) return { ok: true, exists: true };
      if (result?.status === 404) return { ok: true, exists: false };
      return { ok: false, reason: "WhatsApp gave no clear answer for this number." };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
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
    const profileDir = this.chromiumProfileDir();
    const lockFiles = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
    for (const file of lockFiles) {
      await rm(join(profileDir, file), { force: true }).catch(() => undefined);
    }
  }

  /**
   * The directory the library launches Chromium against: `config.userDataDir`, which we never set,
   * so its own default of `${sessionDataPath}/_IGNORE_${sessionId}` (dist/controllers/browser.js).
   */
  private chromiumProfileDir(): string {
    return join(this.sessionDataPath, `_IGNORE_${this.sessionId}`);
  }

  /** See `orphanBrowsers.ts`. Never throws: failing to kill must not fail the attempt. */
  private async killOrphanedBrowsers(when: string): Promise<void> {
    try {
      const killed = await killBrowsersUsingProfile(this.chromiumProfileDir());
      if (killed > 0) {
        console.warn(`[openwa] killed ${killed} orphaned browser process(es) ${when} for ${this.sessionId}`);
      }
    } catch (err) {
      console.error("[openwa] could not clear orphaned browser processes", err);
    }
  }
}
