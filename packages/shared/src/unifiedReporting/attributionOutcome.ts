import type { IntelActor } from "../intelligence/model.js";
import type { SenderMatchStatus } from "../whatsappIdentity.js";

/**
 * A reporting-facing label for WHO SENT a message, derived from the existing classifier's decision
 * (`createReportClassifier`). Never stored, and never a second way of deciding a sender: it only
 * names what the one classifier already decided (04-identity-and-attribution-spec.md §1).
 *
 * An outcome is about the sender. A reply TIER (which customer a reply answered) is a different thing;
 * the two words are never mixed in copy.
 */
export const ATTRIBUTION_OUTCOMES = [
  "VERIFIED_ID_AND_PHONE", // a person; the WhatsApp id and the phone name the same member
  "VERIFIED_SINGLE_IDENTIFIER", // a person; the WhatsApp id only, or the phone only
  "VERIFIED_LINKED_LOGIN", // a dashboard reply by a login linked to a member (credited)
  "OPERATOR_UNLINKED", // a dashboard reply by a login linked to nobody (a verified person, no employee credit)
  "STAFF_CONFLICT", // staff whose identifiers name two members: nobody credited
  "STAFF_AMBIGUOUS", // staff whose identifier is shared by several members: nobody credited
  "STAFF_UNMAPPED", // stamped staff the roster no longer knows (a former or deleted member)
  "CUSTOMER", // nobody on the roster (or before the member's attributeFrom)
  "AUTOMATED_AI",
  "AUTOMATED_RULE",
  "BUSINESS_BROADCAST",
  "BUSINESS_PHONE", // our number, matching no send of ours: a person nobody can name
  "NOT_A_PERSON", // a group, broadcast or newsletter id
] as const;
export type AttributionOutcome = (typeof ATTRIBUTION_OUTCOMES)[number];

/** The part of `ReportSenderDecision` the mapping reads. */
export interface AttributionDecisionInput {
  kind: "MEMBER" | "CUSTOMER" | "BUSINESS";
  memberId: string | null;
  actor: IntelActor;
  status: SenderMatchStatus | null;
}

/** Mapping from the existing classifier's decision. Pure and exhaustive over `IntelActor`. */
export function attributionOutcomeOf(d: AttributionDecisionInput): AttributionOutcome {
  switch (d.actor) {
    case "MEMBER":
      return d.status === "WHATSAPP_ID_AND_PHONE_MATCH" ? "VERIFIED_ID_AND_PHONE" : "VERIFIED_SINGLE_IDENTIFIER";
    case "OPERATOR":
      return d.memberId ? "VERIFIED_LINKED_LOGIN" : "OPERATOR_UNLINKED";
    case "MEMBER_UNMAPPED":
      return d.status === "CONFLICT" ? "STAFF_CONFLICT" : d.status === "AMBIGUOUS" ? "STAFF_AMBIGUOUS" : "STAFF_UNMAPPED";
    case "CUSTOMER":
      return d.status === "NOT_A_PERSON" ? "NOT_A_PERSON" : "CUSTOMER";
    case "AI":
      return "AUTOMATED_AI";
    case "RULE":
      return "AUTOMATED_RULE";
    case "BROADCAST":
      return "BUSINESS_BROADCAST";
    case "BUSINESS_PHONE":
      return "BUSINESS_PHONE";
  }
}

/** Whether an outcome credits a NAMED employee (the only outcomes any per-member figure may use). */
export const isEmployeeCredited = (o: AttributionOutcome): boolean =>
  o === "VERIFIED_ID_AND_PHONE" || o === "VERIFIED_SINGLE_IDENTIFIER" || o === "VERIFIED_LINKED_LOGIN";
