import {
  create,
  ev,
  STATE,
  type ChatId,
  type Client,
  type Content,
  type Message as WaMessage,
} from "@open-wa/wa-automate";
import { prisma } from "@support-automation/db";
import type { RawIncomingMessage } from "../../pipeline/types.js";
import type {
  AccountInfo,
  ConnectionStatus,
  GroupInfo,
  SendResult,
  WhatsAppProvider,
} from "../WhatsAppProvider.js";

function mapState(state: STATE): ConnectionStatus {
  switch (state) {
    case STATE.CONNECTED:
      return "CONNECTED";
    case STATE.UNPAIRED:
    case STATE.UNPAIRED_IDLE:
      return "AUTHENTICATION_REQUIRED";
    case STATE.OPENING:
    case STATE.PAIRING:
    case STATE.SYNCING:
      return "RECONNECTING";
    case STATE.TOS_BLOCK:
    case STATE.SMB_TOS_BLOCK:
    case STATE.PROXYBLOCK:
    case STATE.DEPRECATED_VERSION:
      return "SESSION_ERROR";
    default:
      return "DISCONNECTED";
  }
}

function toRawIncomingMessage(accountId: string, message: WaMessage): RawIncomingMessage {
  return {
    accountId,
    whatsappMessageId: message.id,
    chatId: message.chatId,
    whatsappGroupId: message.isGroupMsg ? message.chatId : null,
    senderPhone: message.from,
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
 * IMPORTANT — session path verification (Phase 0 adjustment #2): open-wa's
 * `sessionDataPath` config only covers its `<sessionId>.data.json` file.
 * Separately, the `node-persist` cache it also relies on writes RELATIVE to
 * the process's current working directory by default, which would silently
 * fall outside the mounted volume and break persistence across container
 * recreation. This class `process.chdir()`s into the session directory
 * before connecting so every relative write lands on the same mounted
 * volume. This was verified by reading the installed package's config
 * typings (see apps/worker's Phase 5 implementation notes) — it has NOT
 * been verified against a live WhatsApp account/QR scan, which this
 * sandboxed environment cannot do. The mandatory acceptance test (connect
 * → restart worker → `docker compose down`/`up` → confirm no QR re-scan)
 * must still be run manually against a real account before production use.
 */
export class OpenWAProvider implements WhatsAppProvider {
  private client: Client | null = null;
  private connectionStatus: ConnectionStatus = "DISCONNECTED";

  constructor(
    private readonly accountId: string,
    private readonly sessionId: string,
    private readonly sessionDataPath: string,
  ) {}

  async connect(): Promise<void> {
    process.chdir(this.sessionDataPath);

    ev.on("qr.**", (qrCode: string, sessionId: string) => {
      if (sessionId !== this.sessionId) return;
      prisma.whatsAppAccount
        .update({
          where: { id: this.accountId },
          data: { qrCode, qrUpdatedAt: new Date(), status: "AUTHENTICATION_REQUIRED" },
        })
        .catch((err) => console.error("[openwa] failed to persist QR code", err));
    });

    this.client = await create({
      sessionId: this.sessionId,
      sessionDataPath: this.sessionDataPath,
      multiDevice: true,
      headless: true,
      useChrome: false,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      qrTimeout: 0, // wait indefinitely — the dashboard displays the QR, no arbitrary deadline
      authTimeout: 0,
      popup: false,
      cacheEnabled: false,
    });

    this.connectionStatus = "CONNECTED";
    await this.persistStatus("CONNECTED");

    await this.client.onStateChanged((state) => {
      const mapped = mapState(state);
      this.connectionStatus = mapped;
      this.persistStatus(mapped).catch((err) =>
        console.error("[openwa] failed to persist state change", err),
      );
    });

    console.log(
      `[openwa] connected. Session files are expected under: ${this.sessionDataPath} — verify this after a real QR scan.`,
    );
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.kill();
      this.client = null;
    }
    this.connectionStatus = "DISCONNECTED";
    await this.persistStatus("DISCONNECTED");
  }

  getConnectionStatus(): ConnectionStatus {
    return this.connectionStatus;
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

  private async persistStatus(status: ConnectionStatus): Promise<void> {
    await prisma.whatsAppAccount.update({
      where: { id: this.accountId },
      data: {
        status,
        lastHeartbeatAt: new Date(),
        ...(status === "CONNECTED" ? { lastConnectedAt: new Date(), qrCode: null } : {}),
      },
    });
  }
}
