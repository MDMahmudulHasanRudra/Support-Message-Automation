/**
 * Counters for what this worker process has actually done since it started.
 *
 * Deliberately in memory and deliberately not a table. Everything durable is already derivable
 * from rows that exist — `Message.processingStatus` counts, `OutboundMessage.status` counts,
 * `AiFallbackDecision.outcome` — and the dashboard reads exactly those. A metrics table would be a
 * second, drifting answer to questions the first one already answers correctly.
 *
 * What those tables cannot tell you is what this PROCESS has seen, which is the question that
 * matters when the suspicion is that it has stopped seeing anything. `received` is the one that
 * earns this module: it counts messages handed over by the provider, so `received` flat while the
 * groups are busy names the listener rather than the pipeline — a distinction no table can draw,
 * because a message that was never received leaves no row anywhere.
 *
 * Resets on restart, which is correct: these describe this process, and a counter that survived it
 * would describe nothing in particular.
 */

export interface WorkerMetrics {
  /** Handed over by the provider — before any filtering, storing or automation. */
  received: number;
  /** Reached a terminal PROCESSED/IGNORED state in the pipeline. */
  processed: number;
  /** Landed FAILED in the pipeline. */
  failed: number;
  /** Stranded rows finished by the recovery sweep, and messages recovered from a gap. */
  retried: number;
  /** Outbound rows the queue actually sent. */
  replied: number;
  /** Times a connected account was found not to be collecting, and the sweep was run. */
  collectionBreaks: number;
}

const counters: WorkerMetrics = {
  received: 0,
  processed: 0,
  failed: 0,
  retried: 0,
  replied: 0,
  collectionBreaks: 0,
};

export function countMetric(name: keyof WorkerMetrics, by = 1): void {
  counters[name] += by;
}

export function readMetrics(): WorkerMetrics {
  return { ...counters };
}
