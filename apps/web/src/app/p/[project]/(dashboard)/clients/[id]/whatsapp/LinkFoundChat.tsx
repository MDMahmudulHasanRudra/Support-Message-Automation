"use client";

import { useTransition } from "react";
import { Link2 } from "lucide-react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Button, useToast } from "@/components/ui";
import { linkWhatsAppChat } from "@/server/actions/clientChatLinks";

/** Confirms the found chat as this client's (the existing, audited link action), then opens it. */
export function LinkFoundChatButton({ clientId, accountId, chatId, openAfter }: { clientId: string; accountId: string; chatId: string; openAfter: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [busy, start] = useTransition();
  return (
    <Button
      loading={busy}
      onClick={() =>
        start(async () => {
          const r = await linkWhatsAppChat(clientId, accountId, chatId);
          showToast({ tone: r.ok ? "success" : "danger", title: r.message });
          if (!r.ok) return;
          if (openAfter) router.push(`/chat/account/${accountId}/personal/${encodeURIComponent(chatId)}`);
          else router.refresh();
        })
      }
    >
      <Link2 className="size-4" aria-hidden /> This is the client — link and open
    </Button>
  );
}
