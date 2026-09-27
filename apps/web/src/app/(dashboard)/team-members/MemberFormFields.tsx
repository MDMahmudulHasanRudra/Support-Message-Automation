import { Select } from "@/components/ui";

export interface MemberFormOptions {
  /** Every Team, disabled ones included so a member still in one can be shown in it. */
  teams: Array<{ id: string; name: string; status: string }>;
  /** Designations and departments already in use — suggestions, never a restriction. */
  designations: string[];
  departments: string[];
}

/**
 * The Team dropdown on every member form. Only ACTIVE Teams are offered for a new assignment; a
 * disabled Team appears only when it is this member's current one, so editing them does not
 * silently move them out of it.
 */
export function TeamSelect({
  teams,
  defaultValue = null,
}: {
  teams: MemberFormOptions["teams"];
  defaultValue?: string | null;
}) {
  const offered = teams.filter((team) => team.status === "ACTIVE" || team.id === defaultValue);
  return (
    <Select name="teamId" defaultValue={defaultValue ?? ""}>
      <option value="">No team</option>
      {offered.map((team) => (
        <option key={team.id} value={team.id}>
          {team.name}
          {team.status === "ACTIVE" ? "" : " (disabled)"}
        </option>
      ))}
    </Select>
  );
}

/**
 * Suggestions for the free-text Designation and Department fields, so "Support Executive" is picked
 * rather than retyped as "Support Exec". Free text on purpose: job titles vary by company, and a
 * fixed list would be one nobody maintains.
 */
export function MemberSuggestionLists({ options }: { options: MemberFormOptions }) {
  return (
    <>
      <datalist id="member-designations">
        {options.designations.map((value) => (
          <option key={value} value={value} />
        ))}
      </datalist>
      <datalist id="member-departments">
        {options.departments.map((value) => (
          <option key={value} value={value} />
        ))}
      </datalist>
    </>
  );
}
