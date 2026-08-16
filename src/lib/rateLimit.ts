/**
 * A minimal in-memory rate limiter. Single-user app, so this is global —
 * no per-IP/per-user bucketing, since there's only one legitimate caller —
 * a fixed-window counter is enough to stop a runaway loop (a buggy client
 * retry, or the agent looping on itself) from hammering an expensive
 * downstream call (the OpenRouter API, here).
 *
 * In-memory means it resets on every cold start/deploy — acceptable for
 * what this guards against, not a security boundary.
 */

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

/** Returns true if the call is allowed (and counts it), false if the
 *  caller should back off. */
export function allow(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || now >= w.resetAt) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (w.count >= max) return false;
  w.count += 1;
  return true;
}
