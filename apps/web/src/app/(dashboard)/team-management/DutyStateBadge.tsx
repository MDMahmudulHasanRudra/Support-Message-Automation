import { Badge } from "@/components/ui";
import type { BadgeColor } from "@/components/ui";
import { DUTY_STATE_LABEL, type DerivedDutyState } from "@/lib/dutyState";

/**
 * One derived state, rendered the same way on every page in this module.
 *
 * The colour mapping is the module's whole editorial position in eight lines, so it is worth
 * reading rather than adjusting by eye.
 *
 * `NO_ACTIVITY` is **grey, not red**. Nobody sent a message from this account; that is all anybody
 * knows. Somebody on the phone all day, in a group the account cannot see, or out at a customer
 * site has worked and produced nothing here, and painting that red would have the software accuse
 * a person on evidence it does not have. Red is reserved for the two states a human actually needs
 * to act on: a manager's explicit ABSENT, and activity recorded during approved leave, which is a
 * contradiction somebody has to resolve.
 */
const STATE_COLOR: Record<DerivedDutyState, BadgeColor> = {
  WORKING: "green",
  OFF_DAY_DUTY: "blue",
  NO_ACTIVITY: "gray",
  OFF: "gray",
  HOLIDAY: "gray",
  UNASSIGNED: "yellow",
  ON_LEAVE: "blue",
  LEAVE_CONFLICT: "red",
  ABSENT: "red",
  EXCUSED: "gray",
};

export function DutyStateBadge({ state }: { state: DerivedDutyState }) {
  return (
    <Badge color={STATE_COLOR[state]} dot>
      {DUTY_STATE_LABEL[state]}
    </Badge>
  );
}
