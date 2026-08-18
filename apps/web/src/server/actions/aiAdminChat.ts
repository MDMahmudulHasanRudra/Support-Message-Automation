"use server";

import { requireSession } from "@/server/auth";
import { runAiAdminChat, type AiAdminChatTurn } from "@/server/aiAdmin/chat";

export interface AiAdminChatState {
  turns: AiAdminChatTurn[];
  error?: string;
}

export async function sendAiAdminMessage(prevState: AiAdminChatState, formData: FormData): Promise<AiAdminChatState> {
  await requireSession();
  const message = String(formData.get("message") ?? "").trim();
  if (!message) return prevState;

  const historyBeforeThisTurn = prevState.turns;
  const userTurn: AiAdminChatTurn = { role: "user", text: message };

  try {
    const result = await runAiAdminChat(historyBeforeThisTurn, message);
    return {
      turns: [...historyBeforeThisTurn, userTurn, { role: "assistant", text: result.reply }],
    };
  } catch (err) {
    return {
      turns: [...historyBeforeThisTurn, userTurn],
      error: err instanceof Error ? err.message : "The AI Admin Assistant hit an unexpected error.",
    };
  }
}
