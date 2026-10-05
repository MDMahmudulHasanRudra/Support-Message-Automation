import { MessagesSquare } from "lucide-react";
import { notFound } from "next/navigation";
import { requireAccess } from "@/server/authorize";
import { prisma } from "@/server/db";

export const metadata = { title: "WhatsApp Chat" };

/**
 * The account's inbox with no conversation open. On a wide screen the list already sits beside
 * this pane, so it only says what to do next; on a phone the workspace shows the list instead.
 */
export default async function ChatAccountIndexPage({ params }: { params: Promise<{ accountId: string }> }) {
  await requireAccess("messages.view");
  const { accountId } = await params;
  const account = await prisma.whatsAppAccount.findUnique({ where: { id: accountId }, select: { label: true } });
  if (!account) notFound();

  return (
    <div className="flex flex-1 items-center justify-center p-10">
      <div className="max-w-sm text-center">
        <span
          aria-hidden
          className="mx-auto flex size-11 items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] text-[color:var(--color-subtle-foreground)] shadow-[var(--shadow-xs),var(--highlight-top)]"
        >
          <MessagesSquare className="size-5" />
        </span>
        <h2 className="mt-4 text-[15px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">Pick a conversation</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
          Every group <strong className="font-medium text-[color:var(--color-foreground)]">{account.label}</strong> belongs to is
          on the left, most recently active first. Anything you send goes out from {account.label}, through the same queue the
          automation uses, so account rate limits still apply.
        </p>
      </div>
    </div>
  );
}
