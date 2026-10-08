import { requireAccess } from "@/server/authorize";

/**
 * The chat module's outer boundary: one permission check for everything under /chat. The
 * workspace itself — the account's conversation list beside the open conversation — is the
 * `account/[accountId]` layout, because the account is part of the URL there (see that file).
 */
export default async function ChatRootLayout({ children }: { children: React.ReactNode }) {
  await requireAccess("messages.view");
  return children;
}
