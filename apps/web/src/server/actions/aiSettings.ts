"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import { FALLBACK_REPLY_LANGUAGE } from "@support-automation/shared";
import { requireSession } from "@/server/auth";
import { isAiResponseMode } from "@/lib/aiResponseModes";
import { logSystemEvent } from "@/server/logSystemEvent";

export interface AiSettingsFormState {
  error?: string;
  success?: boolean;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export async function updateAiSettings(
  _prevState: AiSettingsFormState,
  formData: FormData,
): Promise<AiSettingsFormState> {
  await requireSession();

  const flag = (key: string) => formData.get(key) === "on";
  // An EMPTY box keeps the current value rather than writing 0. `Number("")` is 0 and
  // `Number.isFinite(0)` is true, so the previous form of this helper made the `fallback`
  // argument unreachable dead code and turned "I cleared the field to retype it, then got
  // distracted and saved" into a silent write of the most permissive possible setting — a
  // confidence threshold of 0 means the AI sends whatever it drafts, including an answer it
  // rated 5%. A deliberately typed 0 is still honoured; only a blank is treated as "unchanged".
  const readNumber = (key: string): number | null => {
    const raw = formData.get(key);
    if (raw === null || String(raw).trim() === "") return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const percent = (key: string, fallback: number) => {
    const raw = readNumber(key);
    return raw === null ? fallback : clampPercent(raw);
  };
  const nonNegativeInt = (key: string, fallback: number) => {
    const raw = readNumber(key);
    return raw === null ? fallback : Math.max(0, Math.round(raw));
  };
  // Only the two scopes the enum defines — anything else falls back to the conservative one
  // rather than being written through to the database unchecked.
  const scope = formData.get("aiAutomationScope") === "ALL_MONITORED_GROUPS" ? "ALL_MONITORED_GROUPS" : "PER_GROUP";
  // Validated against the same list the dropdown offers, so the two cannot drift again. Anything
  // unrecognised still falls back to the strictest mode rather than being written through.
  const rawMode = String(formData.get("aiResponseMode") ?? "");
  const responseMode = isAiResponseMode(rawMode) ? rawMode : "STRICT_KNOWLEDGE_ONLY";
  // One WhatsApp group id per line, blanks dropped — the same shape the general notification
  // group field already uses.
  const takeoverNotifyGroupIds = String(formData.get("takeoverNotifyGroupIds") ?? "")
    .split(/[\r\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);

  await prisma.aiSettings.upsert({
    where: { id: "global" },
    update: {
      aiEngineEnabled: flag("aiEngineEnabled"),
      learningEnabled: flag("learningEnabled"),
      autoResponseEnabled: flag("autoResponseEnabled"),
      screenshotResponseEnabled: flag("screenshotResponseEnabled"),
      chatLearningEnabled: flag("chatLearningEnabled"),
      softwareLearningEnabled: flag("softwareLearningEnabled"),
      requirementLearningEnabled: flag("requirementLearningEnabled"),
      announcementAiEnabled: flag("announcementAiEnabled"),
      duplicateSimilarityThreshold: percent("duplicateSimilarityThreshold", 95),
      learningConfidenceThreshold: percent("learningConfidenceThreshold", 90),
      autoApprovalThreshold: percent("autoApprovalThreshold", 95),
      humanReviewThreshold: percent("humanReviewThreshold", 70),
      autoResponseConfidenceThreshold: percent("autoResponseConfidenceThreshold", 90),
      aiReplyCooldownSeconds: nonNegativeInt("aiReplyCooldownSeconds", 300),
      humanTakeoverCooldownMinutes: nonNegativeInt("humanTakeoverCooldownMinutes", 30),
      aiAutomationScope: scope,
      aiRuleGenerationEnabled: flag("aiRuleGenerationEnabled"),
      mentionTeamOnHandover: flag("mentionTeamOnHandover"),
      aiRuleGenerationMinConfidence: percent("aiRuleGenerationMinConfidence", 95),
      takeoverNotifyGroupIds,
      knowledgeFromChatEnabled: flag("knowledgeFromChatEnabled"),
      aiResponseMode: responseMode,
      generalAnswerMinConfidence: percent("generalAnswerMinConfidence", 90),
      communicationStyleLearningEnabled: formData.get("communicationStyleLearningEnabled") === "on",
      // Free text: the model is told this by name, so "Bengali (Bangla)", "English" or "Arabic"
      // all work, and so does AUTO_REPLY_LANGUAGE, which is not a language but the instruction to
      // detect one. Deliberately no whitelist — the field is meant to accept a language this code
      // has never heard of. Empty falls back to the schema default rather than leaving the model
      // to guess, which is how customers ended up being answered in Portuguese.
      defaultReplyLanguage:
        String(formData.get("defaultReplyLanguage") ?? "").trim().slice(0, 60) || FALLBACK_REPLY_LANGUAGE,
      knowledgeMinMessagesPerGroup: nonNegativeInt("knowledgeMinMessagesPerGroup", 25),
    },
    create: { id: "global" },
  });

  await logSystemEvent("INFO", "ai-learning", "AI Settings updated");
  revalidatePath("/ai-learning/settings");
  revalidatePath("/ai-learning");
  return { success: true };
}
