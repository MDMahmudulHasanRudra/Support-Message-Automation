/**
 * Failed sign-in attempts per client address (P1-14, docs/get-assist-ultimate/21).
 *
 * The per-account lockout (loginLockout.ts) stops guessing ONE account's password. It cannot stop guessing
 * across many usernames — an unknown username records nothing anywhere — and the platform operators'
 * sign-in has no lockout at all. This caps FAILED attempts per address: a busy office signing in correctly
 * behind one address is never limited, because only failures count.
 *
 * In memory, in the web process, on purpose. A table would need a migration, and code deployed before its
 * migration would make every sign-in fail (the P2022 incident in CLAUDE.md); this cannot fail that way. The
 * costs, accepted: a restart forgets the counts, and a second web instance would count separately.
 *
 * The address is the first `x-forwarded-for` entry, which is the real client only because Caddy overwrites
 * what a client sends. A request reaching the app's port directly can name any address, so this limit
 * needs that port closed to the outside (P1-3, doc 16), like every other use of the header here.
 */

export interface FailureWindowConfig {
  /** Failures allowed per address per window; the next attempt is refused. */
  maxFailures: number;
  windowMs: number;
  /** Addresses remembered at most, so spoofed addresses cannot grow memory without limit. */
  maxKeys: number;
}

interface Bucket {
  windowStart: number;
  failures: number;
}

export interface LimitState {
  limited: boolean;
  /** Whole seconds until the window ends; 0 when not limited. */
  retryAfterSeconds: number;
}

export class FailureWindow {
  private readonly buckets = new Map<string, Bucket>();
  private readonly config: FailureWindowConfig;
  private readonly now: () => number;

  // Plain fields, not constructor parameter properties: Node's type stripping rejects those (see the
  // worker boot crash fixed on hotfix/worker-strip-types), and this module must not depend on the compiler.
  constructor(config: FailureWindowConfig, now: () => number = Date.now) {
    this.config = config;
    this.now = now;
  }

  private current(key: string): Bucket | null {
    const bucket = this.buckets.get(key);
    if (!bucket) return null;
    if (this.now() - bucket.windowStart >= this.config.windowMs) {
      this.buckets.delete(key);
      return null;
    }
    return bucket;
  }

  private stateOf(bucket: Bucket | null): LimitState {
    if (!bucket || bucket.failures < this.config.maxFailures) return { limited: false, retryAfterSeconds: 0 };
    return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStart + this.config.windowMs - this.now()) / 1000)) };
  }

  /** Whether this address may try now. Asked BEFORE anything is looked up. */
  check(key: string): LimitState {
    return this.stateOf(this.current(key));
  }

  /** One failed attempt. Returns the state after it, and whether this failure is the one that reached the limit. */
  recordFailure(key: string): LimitState & { reachedNow: boolean } {
    let bucket = this.current(key);
    if (!bucket) {
      this.evictIfFull();
      bucket = { windowStart: this.now(), failures: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.failures += 1;
    return { ...this.stateOf(bucket), reachedNow: bucket.failures === this.config.maxFailures };
  }

  /** How many addresses are remembered (tests and diagnostics). */
  get size(): number {
    return this.buckets.size;
  }

  private evictIfFull(): void {
    if (this.buckets.size < this.config.maxKeys) return;
    for (const [key, bucket] of this.buckets) {
      if (this.now() - bucket.windowStart >= this.config.windowMs) this.buckets.delete(key);
    }
    // Still full: drop the oldest (Map keeps insertion order). An attacker cycling addresses evicts its own
    // entries first, since they are the newest only for a moment.
    while (this.buckets.size >= this.config.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

const WINDOW_MS = envInt("AUTH_IP_WINDOW_MINUTES", 15, 1, 24 * 60) * 60_000;

/** Customer sign-in (/login), password and two-step code together. */
export const userSignInFailures = new FailureWindow({
  maxFailures: envInt("AUTH_IP_MAX_FAILURES", 20, 3, 10_000),
  windowMs: WINDOW_MS,
  maxKeys: 10_000,
});

/** Platform operators' sign-in: fewer people, more power, and no per-account lockout behind it. */
export const platformSignInFailures = new FailureWindow({
  maxFailures: envInt("PLATFORM_AUTH_IP_MAX_FAILURES", 10, 3, 10_000),
  windowMs: WINDOW_MS,
  maxKeys: 10_000,
});

/** The client address as this app reads it everywhere else (see the note on Caddy above). */
export function clientAddress(headers: Pick<Headers, "get">): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip")?.trim() || "unknown";
}

export function tooManyAttemptsMessage(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many failed sign-in attempts from this network. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}
