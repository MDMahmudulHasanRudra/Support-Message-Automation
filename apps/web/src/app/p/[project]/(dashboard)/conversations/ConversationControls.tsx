"use client";

import { useState, useTransition } from "react";
import { Bot, CheckCircle2, RotateCcw, RotateCw, UserCheck, UserMinus } from "lucide-react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Button, ConfirmDialog, useToast } from "@/components/ui";
import {
  assignChannelConversationAction,
  resumeChannelAiAction,
  retryChannelReplyAction,
  setChannelConversationStatusAction,
  type InboxActionResult,
} from "@/server/actions/channelInbox";

/** Close / reopen, assign to me / unassign, and hand back to AI — each reported in plain words. */
export function ConversationControls({
  conversationId,
  status,
  assignedToMe,
  assigned,
  aiPaused,
  canReply,
}: {
  conversationId: string;
  status: "OPEN" | "CLOSED";
  assignedToMe: boolean;
  assigned: boolean;
  aiPaused: boolean;
  canReply: boolean;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  if (!canReply) return null;

  const run = (action: () => Promise<InboxActionResult>) =>
    startTransition(async () => {
      const result = await action();
      showToast({ tone: result.error ? "danger" : "success", title: result.error ?? result.success ?? "Done" });
      router.refresh();
    });

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {aiPaused ? (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => resumeChannelAiAction(conversationId))} title="AI is paused because a person replied. Let it answer the next message.">
          <Bot className="size-3.5" aria-hidden />
          Resume AI
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => assignChannelConversationAction(conversationId, !assignedToMe))}>
        {assignedToMe ? <UserMinus className="size-3.5" aria-hidden /> : <UserCheck className="size-3.5" aria-hidden />}
        {assignedToMe ? "Unassign" : assigned ? "Take over" : "Assign to me"}
      </Button>
      <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => setChannelConversationStatusAction(conversationId, status === "OPEN" ? "CLOSED" : "OPEN"))}>
        {status === "OPEN" ? <CheckCircle2 className="size-3.5" aria-hidden /> : <RotateCcw className="size-3.5" aria-hidden />}
        {status === "OPEN" ? "Close" : "Reopen"}
      </Button>
    </div>
  );
}

/** Send a failed or unconfirmed reply again. An unconfirmed one may have arrived, so it asks first. */
export function RetryReplyButton({ messageId, unknown }: { messageId: string; unknown: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const retry = () =>
    startTransition(async () => {
      const result = await retryChannelReplyAction(messageId, unknown);
      setConfirming(false);
      showToast({ tone: result.error ? "danger" : "success", title: result.error ?? result.success ?? "Queued again." });
      router.refresh();
    });
  return (
    <>
      <button
        type="button"
        disabled={pending}
        onClick={() => (unknown ? setConfirming(true) : retry())}
        className="inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline disabled:opacity-50"
      >
        <RotateCw className="size-3" aria-hidden />
        Send again
      </button>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={retry}
        loading={pending}
        title="Send this reply again?"
        description="It is not known whether the first attempt reached the customer. Check the conversation in the provider's own app first — if it arrived, sending again gives them the same message twice."
        confirmLabel="I checked — send again"
      />
    </>
  );
}
