import { Search, X } from "lucide-react";
import { Button, ButtonLink } from "./Button";
import { Input } from "./Field";

/**
 * The one search control every list in the console uses.
 *
 * It is a plain GET form, not a client component with debounced state, because that is what the
 * rest of this app already does: pages are server-rendered and read their filters from the URL, so
 * a search is just another query parameter. That also means a searched list can be bookmarked,
 * shared with a colleague, and survives a refresh — none of which is true of local input state.
 *
 * `preserve` carries the page's other filters through as hidden fields. Without it, searching
 * silently resets whatever else the operator had narrowed to, which reads as the filter being
 * broken. `page` is deliberately never preserved: results change, so page 4 of the old result set
 * is meaningless and usually empty.
 */
export function SearchField({
  name = "search",
  placeholder = "Search…",
  defaultValue = "",
  preserve = {},
  width = "w-64",
}: {
  name?: string;
  placeholder?: string;
  defaultValue?: string;
  /** Other active filters, carried through the search so it narrows rather than resets. */
  preserve?: Record<string, string | undefined>;
  width?: string;
}) {
  const active = defaultValue.trim().length > 0;
  const clearHref = buildQuery(preserve) || "?";

  return (
    <form className="flex flex-wrap items-end gap-2" method="GET" role="search">
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[color:var(--color-muted-foreground)]"
        />
        <Input
          name={name}
          type="search"
          aria-label={placeholder}
          placeholder={placeholder}
          defaultValue={defaultValue}
          className={`${width} pl-8`}
        />
      </div>

      {Object.entries(preserve).map(([key, value]) =>
        value ? <input key={key} type="hidden" name={key} value={value} /> : null,
      )}

      <Button type="submit" size="sm">
        Search
      </Button>

      {/* Only offered once a search is actually active — an always-present Clear beside an empty
          box is a control that does nothing, and reads as one that is broken. */}
      {active ? (
        <ButtonLink href={clearHref} variant="ghost" size="sm">
          <X className="size-3.5" aria-hidden />
          Clear
        </ButtonLink>
      ) : null}
    </form>
  );
}

function buildQuery(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}
