/**
 * Scroll decisions for the v2 conversation view (CHAT_UI_V2.md). Pure, so each rule is a unit test
 * rather than something only a browser can show.
 *
 * The two thresholds and the "only a person's scroll pages back" rule follow the reference dashboard
 * (rmyndharis/OpenWA, `scrollDecision.ts`, MIT — the idea, not the code; see
 * docs/third-party/OPENWA_REFERENCE.md). The prepend arithmetic is this app's own.
 */

export interface ScrollGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Close enough to the bottom that the reader is following the conversation rather than reading back. */
export const NEAR_BOTTOM_PX = 100;
/** Close enough to the top that the next older page should be loaded. */
export const NEAR_TOP_PX = 100;

export function distanceFromBottom(g: ScrollGeometry): number {
  return g.scrollHeight - g.scrollTop - g.clientHeight;
}

/**
 * What to do when a newer message appears. `before` is the geometry captured BEFORE it was added:
 * after the append the reader is always "far from the bottom", which is the wrong question.
 *   - our own send: always follow it (you just pressed send);
 *   - anything else: follow only if you were already at the bottom; otherwise hold still and count it.
 */
export function decideOnArrival(ownSend: boolean, before: ScrollGeometry, threshold = NEAR_BOTTOM_PX): "bottom" | "hold" {
  if (ownSend) return "bottom";
  return distanceFromBottom(before) <= threshold ? "bottom" : "hold";
}

/**
 * Whether reaching the top should load the next older page. Only a person's scroll counts: the first
 * render of a short thread reports scrollTop 0 too, and treating that as "reached the top" would pull
 * the whole history in a burst of requests.
 */
export function shouldLoadOlder(input: {
  userScroll: boolean;
  geometry: ScrollGeometry;
  hasMore: boolean;
  loading: boolean;
  threshold?: number;
}): boolean {
  const { userScroll, geometry, hasMore, loading, threshold = NEAR_TOP_PX } = input;
  if (!userScroll || !hasMore || loading) return false;
  if (geometry.scrollHeight <= geometry.clientHeight) return false;
  return geometry.scrollTop < threshold;
}

/**
 * Where to put scrollTop after older messages were added ABOVE the reader, so the message they were
 * looking at stays exactly where it was: everything moved down by the height that was added.
 */
export function scrollTopAfterPrepend(before: ScrollGeometry, newScrollHeight: number): number {
  return Math.max(0, before.scrollTop + (newScrollHeight - before.scrollHeight));
}
