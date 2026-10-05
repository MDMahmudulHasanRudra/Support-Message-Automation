/**
 * Small client-side helpers for the chat workspace's account choice.
 *
 * The URL is the authority on which account a tab is working in (`/chat/account/<id>/…`). The last
 * account opened is remembered in this browser only so /chat can open it again next time — a
 * convenience, never something a request reads. Every access is wrapped: private mode throwing must
 * not stop the inbox rendering.
 */
const LAST_ACCOUNT_KEY = "chat-last-account";

export function rememberChatAccount(accountId: string): void {
  try {
    window.localStorage.setItem(LAST_ACCOUNT_KEY, accountId);
  } catch {
    /* storage unavailable */
  }
}

export function lastChatAccount(): string | null {
  try {
    return window.localStorage.getItem(LAST_ACCOUNT_KEY);
  } catch {
    return null;
  }
}

/** How an account's connection reads in the selector: a dot colour and a word. */
export function accountStatusTone(status: string): { dot: string; label: string } {
  switch (status) {
    case "CONNECTED":
      return { dot: "bg-[var(--color-success)]", label: "Connected" };
    case "RECONNECTING":
      return { dot: "bg-[var(--color-warning)]", label: "Reconnecting" };
    case "AUTHENTICATION_REQUIRED":
      return { dot: "bg-[var(--color-warning)]", label: "Needs linking" };
    case "SESSION_ERROR":
    case "ERROR":
      return { dot: "bg-[var(--color-danger)]", label: "Error" };
    default:
      return { dot: "bg-[var(--color-subtle-foreground)]", label: "Disconnected" };
  }
}
