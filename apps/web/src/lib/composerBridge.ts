/**
 * Lets the inbox workspace panel put Copilot text into whichever reply composer is on the page, and
 * read what the agent has typed (for "rewrite what I typed"). One composer is mounted per
 * conversation page; the most recently mounted one wins.
 *
 * It only ever fills the box — sending stays the agent's own click on the composer's Send button,
 * so every check the composer and its server action make still applies.
 */
export interface ComposerHandle {
  /** Replace the box's text (the agent's own draft is kept in its browser draft until they send). */
  fill(text: string): void;
  read(): string;
}

let active: ComposerHandle | null = null;

export function registerComposer(handle: ComposerHandle): () => void {
  active = handle;
  return () => {
    if (active === handle) active = null;
  };
}

/** False when there is no composer to fill (read-only role, closed conversation). */
export function fillComposer(text: string): boolean {
  if (!active) return false;
  active.fill(text);
  return true;
}

export function readComposer(): string | null {
  return active ? active.read() : null;
}
