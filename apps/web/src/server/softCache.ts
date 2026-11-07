import { after } from "next/server";
import { requireActiveProject, runWithProject } from "@/server/projectContext";

/**
 * Heavy, project-wide figures (charts, the team's workload) answered at once from their last result, then
 * worked out again behind the response so the next person gets newer numbers.
 *
 * Only for figures that do not depend on who is looking, and that a minute's age cannot mislead: never a
 * queue, a list somebody acts on, or anything money. The key always carries the project, so one project can
 * never read another's. In this process's memory on purpose: a restart simply works them out again, and the
 * database stays the only record.
 */

interface Entry {
  at: number;
  value: unknown;
}

const MAX_ENTRIES = 500;
const entries = new Map<string, Entry>();
const refreshing = new Map<string, Promise<unknown>>();

function remember(key: string, value: unknown): void {
  entries.delete(key);
  entries.set(key, { at: Date.now(), value });
  if (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
}

/** One calculation at a time per key: ten people opening the Overview run it once. */
function run<T>(key: string, load: () => Promise<T>): Promise<T> {
  const running = refreshing.get(key);
  if (running) return running as Promise<T>;
  const started = load()
    .then((value) => {
      remember(key, value);
      return value;
    })
    .finally(() => refreshing.delete(key));
  refreshing.set(key, started);
  return started;
}

export const FIGURES_FRESH_MS = 60_000;
/** Older than this the page waits for a new answer: half an hour old is no longer "just now". */
export const FIGURES_USABLE_MS = 30 * 60_000;

export async function softCached<T>(name: string, load: () => Promise<T>): Promise<T> {
  const project = await requireActiveProject();
  const key = `${project.id}:${name}`;
  const known = entries.get(key);
  const age = known ? Date.now() - known.at : Infinity;
  if (known && age < FIGURES_FRESH_MS) return known.value as T;
  if (known && age < FIGURES_USABLE_MS) {
    // After the response there are no request headers, so the project is handed in explicitly.
    after(() => runWithProject(project, () => run(key, load).catch(() => undefined)));
    return known.value as T;
  }
  return run(key, load);
}
