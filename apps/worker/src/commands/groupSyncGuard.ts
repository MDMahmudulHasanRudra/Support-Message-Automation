/**
 * Whether a group sync's read is complete enough to deactivate what it did not see.
 *
 * The sweep in `syncGroups` marks every active group missing from the provider's list as inactive.
 * That is right when the list is the whole roster and badly wrong when it is not — and it is not,
 * straight after a number is linked: the phone is still pushing its chats to the new device, so
 * WhatsApp Web's chat list fills in over minutes. On 24 Sep 2026 a sync two minutes after linking
 * read 498 of 1,952 groups. Anything that makes the inbox list only active groups then hides three
 * quarters of the conversations, while their messages keep arriving.
 *
 * People leave groups a few at a time. A read that would switch off more than a tenth of an
 * account's active groups at once (and more than a handful, so a small account can still tidy up)
 * is far more likely to be a partial read than a mass exodus, so the sweep holds and says so. The
 * cost of being wrong in that direction is a stale group left active until the next sync — sends
 * to it fail the membership check, visibly. The cost of the other direction is the inbox going
 * dark for most customers.
 */
export const SWEEP_HOLD_MIN_GROUPS = 20;
export const SWEEP_HOLD_FRACTION = 0.1;

export function shouldHoldDeactivationSweep(activeBefore: number, wouldDeactivate: number): boolean {
  if (wouldDeactivate <= SWEEP_HOLD_MIN_GROUPS) return false;
  return wouldDeactivate > activeBefore * SWEEP_HOLD_FRACTION;
}
