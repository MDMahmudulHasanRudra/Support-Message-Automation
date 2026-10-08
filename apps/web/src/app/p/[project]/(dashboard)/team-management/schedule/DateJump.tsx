import { Button, Input } from "@/components/ui";

/**
 * Which date the roster is showing.
 *
 * A plain GET form, like `SearchField` and every other filter in this app — so a date can be
 * bookmarked, pasted to a colleague and survives a refresh. A client-side date picker writing to
 * state would give none of that.
 */
export function DateJump({ date }: { date: string }) {
  return (
    <form method="GET" className="flex items-end gap-2">
      <Input type="date" name="date" defaultValue={date} aria-label="Roster date" className="w-44" />
      <Button type="submit" variant="secondary">
        Go
      </Button>
    </form>
  );
}
