import { parseAmount, normalizeCurrencyCode } from "./clientBilling.js";
import { currencyDecimals, toMinor } from "./clientPayments.js";
import { isSubscriptionDurationUnit, MAX_SUBSCRIPTION_DURATION, parseCalendarDay, SUBSCRIPTION_DURATION_LABELS, type SubscriptionDurationUnit } from "./clientSubscriptions.js";

/**
 * Renewal offers (CLIENT_CRM_V7.md §4). An offer is a proposal to a client whose term is ending — what
 * service, for how long, at what price — and the record of the conversation about it. It is NOT money:
 * no invoice, no due and no balance exists because an offer was prepared, sent, or even accepted. Money
 * starts only when a person renews (a new term) and, separately, raises an invoice.
 *
 * Pure rules only; the database guards the same transitions with conditional updates.
 */

export const RENEWAL_OFFER_STATUSES = ["PREPARED", "CONTACTED", "AWAITING_RESPONSE", "ACCEPTED", "DECLINED", "RENEWED", "WITHDRAWN"] as const;
export type RenewalOfferStatus = (typeof RENEWAL_OFFER_STATUSES)[number];
export const isRenewalOfferStatus = (v: unknown): v is RenewalOfferStatus => typeof v === "string" && (RENEWAL_OFFER_STATUSES as readonly string[]).includes(v);

export const RENEWAL_OFFER_STATUS_LABELS: Record<RenewalOfferStatus, string> = {
  PREPARED: "Offer prepared",
  CONTACTED: "Offer sent",
  AWAITING_RESPONSE: "Awaiting response",
  ACCEPTED: "Customer accepted",
  DECLINED: "Declined",
  RENEWED: "Renewed",
  WITHDRAWN: "Withdrawn",
};

/** Statuses in which the offer is still being worked on. At most one such offer per term (partial unique index). */
export const OPEN_RENEWAL_OFFER_STATUSES: readonly RenewalOfferStatus[] = ["PREPARED", "CONTACTED", "AWAITING_RESPONSE", "ACCEPTED"];
export const isOpenRenewalOffer = (status: string): boolean => (OPEN_RENEWAL_OFFER_STATUSES as readonly string[]).includes(status);

/** What a person can do to an offer. RENEW is the only one that creates anything outside the offer (a term). */
export const RENEWAL_OFFER_ACTIONS = ["RECORD_CONTACT", "MARK_AWAITING", "ACCEPT", "DECLINE", "WITHDRAW", "SCHEDULE_FOLLOW_UP", "RENEW"] as const;
export type RenewalOfferAction = (typeof RENEWAL_OFFER_ACTIONS)[number];

const TRANSITIONS: Record<RenewalOfferAction, { from: readonly RenewalOfferStatus[]; to: RenewalOfferStatus | null }> = {
  // A contact attempt can be recorded any number of times while the offer is open; the first moves it to "sent".
  RECORD_CONTACT: { from: ["PREPARED", "CONTACTED", "AWAITING_RESPONSE", "ACCEPTED"], to: null },
  MARK_AWAITING: { from: ["PREPARED", "CONTACTED"], to: "AWAITING_RESPONSE" },
  ACCEPT: { from: ["PREPARED", "CONTACTED", "AWAITING_RESPONSE"], to: "ACCEPTED" },
  DECLINE: { from: ["PREPARED", "CONTACTED", "AWAITING_RESPONSE", "ACCEPTED"], to: "DECLINED" },
  WITHDRAW: { from: ["PREPARED", "CONTACTED", "AWAITING_RESPONSE", "ACCEPTED"], to: "WITHDRAWN" },
  SCHEDULE_FOLLOW_UP: { from: ["PREPARED", "CONTACTED", "AWAITING_RESPONSE", "ACCEPTED"], to: null },
  // Renewing is from an ACCEPTED offer only: a customer's yes is recorded first, by a person.
  RENEW: { from: ["ACCEPTED"], to: "RENEWED" },
};

/** The status an action leads to from `from`, or a sentence saying why it cannot be done. */
export function nextOfferStatus(from: string, action: RenewalOfferAction): { ok: true; to: RenewalOfferStatus } | { ok: false; error: string } {
  const rule = TRANSITIONS[action];
  if (!isRenewalOfferStatus(from) || !rule.from.includes(from)) {
    if (from === "RENEWED") return { ok: false, error: "This offer has already been renewed." };
    if (from === "DECLINED" || from === "WITHDRAWN") return { ok: false, error: `This offer was ${from === "DECLINED" ? "declined" : "withdrawn"}. Prepare a new offer instead.` };
    if (action === "RENEW") return { ok: false, error: "Record the customer's acceptance before renewing from this offer." };
    return { ok: false, error: "That step does not apply to this offer any more. Reload the page." };
  }
  if (rule.to) return { ok: true, to: rule.to };
  // RECORD_CONTACT moves a fresh offer to "sent"; otherwise the status stays.
  return { ok: true, to: action === "RECORD_CONTACT" && from === "PREPARED" ? "CONTACTED" : (from as RenewalOfferStatus) };
}

export const RENEWAL_OFFER_LIMITS = { service: 120, note: 1000, response: 1000 } as const;
export const CONTACT_CHANNELS = ["WHATSAPP", "EMAIL", "PHONE_CALL", "IN_PERSON", "MESSENGER", "INSTAGRAM", "OTHER"] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];
export const CONTACT_CHANNEL_LABELS: Record<ContactChannel, string> = {
  WHATSAPP: "WhatsApp",
  EMAIL: "Email",
  PHONE_CALL: "Phone call",
  IN_PERSON: "In person",
  MESSENGER: "Messenger",
  INSTAGRAM: "Instagram",
  OTHER: "Other",
};
export const isContactChannel = (v: unknown): v is ContactChannel => typeof v === "string" && (CONTACT_CHANNELS as readonly string[]).includes(v);

export interface RenewalOfferInput {
  service: string;
  durationValue: string;
  durationUnit: string;
  amount: string;
  currency: string;
  validUntil: string;
  followUpDate: string;
  note: string;
}

export interface ValidRenewalOffer {
  service: string;
  durationValue: number;
  durationUnit: SubscriptionDurationUnit;
  /** Two-decimal string, or null when no price is proposed yet. */
  amount: string | null;
  currency: string | null;
  validUntil: string | null;
  followUpDate: string | null;
  note: string | null;
}

/**
 * One offer. A service and a duration are required; a price is optional (an offer may be "renew on the same
 * terms"), but an amount needs an enabled currency and must fit that currency's decimals — the same rules an
 * invoice uses, so an accepted offer can become an invoice without being re-typed.
 */
export function validateRenewalOffer(input: RenewalOfferInput, enabledCurrencies: readonly string[], today: string): { ok: true; value: ValidRenewalOffer } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const service = input.service.trim();
  if (!service) errors.push("Name the service or plan being offered.");
  else if (service.length > RENEWAL_OFFER_LIMITS.service) errors.push(`The service name can be at most ${RENEWAL_OFFER_LIMITS.service} characters.`);

  const n = Number(input.durationValue.trim());
  const unit = input.durationUnit.trim();
  let durationValue = 0;
  let durationUnit: SubscriptionDurationUnit = "MONTH";
  if (!input.durationValue.trim() || !Number.isInteger(n) || n < 1) errors.push("The proposed duration must be a whole number of at least 1.");
  else if (!isSubscriptionDurationUnit(unit)) errors.push("Choose days, weeks, months or years.");
  else if (n > MAX_SUBSCRIPTION_DURATION[unit]) errors.push(`At most ${MAX_SUBSCRIPTION_DURATION[unit]} ${SUBSCRIPTION_DURATION_LABELS[unit][1]}.`);
  else {
    durationValue = n;
    durationUnit = unit;
  }

  let amount: string | null = null;
  let currency: string | null = null;
  const rawAmount = input.amount.trim();
  const rawCurrency = input.currency.trim();
  if (rawAmount) {
    const parsed = parseAmount(rawAmount, "The proposed amount");
    if (!parsed.ok) errors.push(parsed.error);
    else amount = parsed.value;
    currency = normalizeCurrencyCode(rawCurrency);
    if (!currency) errors.push("Choose the currency of the proposed amount.");
    else if (!enabledCurrencies.includes(currency)) errors.push(`${currency} is not one of this project's billing currencies.`);
    else if (amount !== null) {
      const minor = toMinor(amount);
      const decimals = currencyDecimals(currency);
      if (minor !== null && decimals < 2 && minor % 10n ** BigInt(2 - decimals) !== 0n) errors.push(decimals === 0 ? `${currency} has no decimals.` : `${currency} has only ${decimals} decimal.`);
    }
  } else if (rawCurrency) {
    // A currency on its own says nothing; it is simply not kept.
    currency = null;
  }

  const day = (raw: string, label: string) => {
    if (!raw.trim()) return null;
    const d = parseCalendarDay(raw);
    if (!d) errors.push(`${label} is not a real date.`);
    return d;
  };
  const validUntil = day(input.validUntil, "The valid-until date");
  const followUpDate = day(input.followUpDate, "The follow-up date");
  if (validUntil && validUntil < today) errors.push("The offer cannot be valid only until a day that has passed.");

  const note = input.note.trim();
  if (note.length > RENEWAL_OFFER_LIMITS.note) errors.push(`The note can be at most ${RENEWAL_OFFER_LIMITS.note} characters.`);

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { service, durationValue, durationUnit, amount, currency: amount === null ? null : currency, validUntil, followUpDate, note: note || null } };
}

/** The Renewal workspace's views. Each is a plain filter over stored offers and terms — no stored "pending debt". */
export const RENEWAL_VIEWS = ["renewing", "expired", "prepared", "sent", "awaiting", "accepted", "renewed", "declined", "follow-up"] as const;
export type RenewalView = (typeof RENEWAL_VIEWS)[number];
export const RENEWAL_VIEW_LABELS: Record<RenewalView, string> = {
  renewing: "Renewing soon",
  expired: "Expired",
  prepared: "Offer prepared",
  sent: "Offer sent",
  awaiting: "Awaiting response",
  accepted: "Customer accepted",
  renewed: "Renewed",
  declined: "Declined",
  "follow-up": "Follow-up due",
};
/** The offer status each offer-view lists. The two term views ("renewing", "expired") and "follow-up" are not status views. */
export const RENEWAL_VIEW_STATUS: Partial<Record<RenewalView, RenewalOfferStatus>> = {
  prepared: "PREPARED",
  sent: "CONTACTED",
  awaiting: "AWAITING_RESPONSE",
  accepted: "ACCEPTED",
  renewed: "RENEWED",
  declined: "DECLINED",
};

/** "Valid until" has passed while the offer is still open: shown as a warning, never acted on by itself. */
export function offerLapsed(offer: { status: string; validUntil: string | null }, today: string): boolean {
  return isOpenRenewalOffer(offer.status) && offer.status !== "ACCEPTED" && offer.validUntil !== null && offer.validUntil < today;
}

/** A follow-up is due on or before today while the offer is open. */
export function followUpDue(offer: { status: string; followUpDate: string | null }, today: string): boolean {
  return isOpenRenewalOffer(offer.status) && offer.followUpDate !== null && offer.followUpDate <= today;
}
