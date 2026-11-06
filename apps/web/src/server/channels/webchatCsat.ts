import { CSAT_ANSWER_WINDOW_HOURS, readCsatComment, readCsatRating } from "@support-automation/shared";
import { platformPrisma } from "@/server/db";
import { disabledFeaturesFor } from "@/server/projectFeatures";
import { WebchatError, type PublicWidget, type Visitor } from "./webchat";

/**
 * The website chat half of satisfaction surveys (CSAT.md): the rating card the widget shows after the team
 * resolved the visitor's conversation, and the visitor's answer. Public API code (no session), so it reads with
 * the platform client and names the widget's project in every query; the visitor is proven by the bearer token
 * the caller has already checked (`visitorFromToken`), and only ever reaches a survey of their OWN conversation.
 * Fails closed: no token, another visitor's survey, an answered or expired one, or the feature off — no card,
 * and no answer recorded.
 */

export interface VisitorCsatPrompt {
  id: string;
  question: string;
}

async function csatOn(widget: PublicWidget): Promise<boolean> {
  return !(await disabledFeaturesFor(widget.projectId)).has("CSAT_SURVEYS");
}

const windowStart = (now: Date) => new Date(now.getTime() - CSAT_ANSWER_WINDOW_HOURS * 3_600_000);

/** The card to show this visitor now, or null. */
export async function visitorCsatPrompt(widget: PublicWidget, visitor: Visitor, now: Date = new Date()): Promise<VisitorCsatPrompt | null> {
  if (!(await csatOn(widget))) return null;
  const survey = await platformPrisma.csatSurvey.findFirst({
    where: {
      projectId: widget.projectId,
      channel: "WEBCHAT",
      status: "SENT",
      answeredAt: null,
      answerClosedAt: null,
      sentAt: { gte: windowStart(now) },
      channelConversation: { projectId: widget.projectId, connectionId: widget.connectionId, externalThreadId: visitor.id },
    },
    orderBy: { sentAt: "desc" },
    select: { id: true, question: true },
  });
  return survey ? { id: survey.id, question: survey.question ?? "" } : null;
}

/** Records the visitor's rating (1–5) and optional comment, once. Throws WebchatError with what the widget may show. */
export async function submitVisitorCsat(widget: PublicWidget, visitor: Visitor, input: { surveyId: unknown; rating: unknown; comment: unknown }, now: Date = new Date()): Promise<void> {
  const rating = readCsatRating(input.rating);
  if (rating === null) throw new WebchatError("Choose a rating from 1 to 5.", 400);
  if (typeof input.surveyId !== "string" || input.surveyId.length > 40) throw new WebchatError("This survey is no longer available.", 404);
  if (!(await csatOn(widget))) throw new WebchatError("This survey is no longer available.", 404);
  const comment = readCsatComment(input.comment);
  // One conditional write, scoped to this visitor's own conversation on this widget: a forged id, another
  // visitor's survey, a second submit or an expired survey all change nothing.
  const answered = await platformPrisma.csatSurvey.updateMany({
    where: {
      id: input.surveyId,
      projectId: widget.projectId,
      channel: "WEBCHAT",
      status: "SENT",
      answeredAt: null,
      answerClosedAt: null,
      sentAt: { gte: windowStart(now) },
      channelConversation: { projectId: widget.projectId, connectionId: widget.connectionId, externalThreadId: visitor.id },
    },
    data: { answeredAt: now, answerClosedAt: now, rating, comment, answerSource: "WIDGET" },
  });
  if (answered.count === 0) throw new WebchatError("This survey is no longer available.", 404);
}
