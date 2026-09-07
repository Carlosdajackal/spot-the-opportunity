// netlify/functions/lib/rate-limit.mjs
//
// Shared rate limiting for all three endpoints (spot, dig, test).
//
// LECTURE-THEATRE REASONING (read before changing these numbers):
// Students use this tool live, in lectures and bootcamps of up to ~150
// people, on shared campus wifi. That means dozens or hundreds of students
// can appear to us behind a small handful of shared public IP addresses.
// If we rate-limited *per IP* as the primary control, one popular lecture
// could look like a single caller making 150 requests in ten minutes and
// get the whole theatre locked out mid-session — the opposite of what a
// rate limit is for.
//
// So the primary control is a per-browser-session limit: the client
// generates a random id once, stores it in localStorage, and sends it on
// every request. That's what we actually want to bound (one student
// hammering "try again"), and it isn't affected by how many other students
// share their IP. The IP limit below still exists, but only as a much
// looser anti-abuse backstop — high enough that a full lecture theatre on
// one shared IP never trips it, low enough to catch a genuine scripted
// abuser hitting us from a single machine.
export const SESSION_HOURLY_LIMIT = 25; // generations per browser session per hour
export const IP_HOURLY_BACKSTOP = 400; // anti-abuse backstop per IP per hour — NOT a per-user limit
export const SITE_DAILY_LIMIT = 600; // generations per day, site-wide, across all three endpoints

const STORE_NAME = "rate-limits";

import { getStore } from "@netlify/blobs";

/**
 * Checks all three limits and, if all pass, reserves one generation against
 * each. Counters only — never stores request/response content.
 *
 * Netlify Blobs has no built-in atomic increment, so this is read-then-write
 * (last write wins); under heavy concurrent bursts the true count could
 * drift slightly past a limit, which is an acceptable tradeoff for a
 * cost-control guardrail rather than a hard security boundary.
 *
 * @param {{ ip: string, sessionId: string }} identity
 * @returns {Promise<{ allowed: boolean, message?: string }>}
 */
export async function checkAndReserveRateLimit({ ip, sessionId }) {
  const store = getStore(STORE_NAME);
  const now = new Date();
  const dayKey = `site:${now.toISOString().slice(0, 10)}`;
  const hourBucket = Math.floor(now.getTime() / 3_600_000);
  const ipKey = `ip:${ip || "unknown"}:${hourBucket}`;
  const sessionKey = `session:${sessionId || "anonymous"}:${hourBucket}`;

  const [dayCount, ipCount, sessionCount] = await Promise.all([
    store.get(dayKey, { type: "json" }),
    store.get(ipKey, { type: "json" }),
    store.get(sessionKey, { type: "json" }),
  ]);

  if ((dayCount ?? 0) >= SITE_DAILY_LIMIT) {
    return {
      allowed: false,
      message: "Spot the Opportunity has reached its generation limit for today. Please try again tomorrow.",
    };
  }

  if ((ipCount ?? 0) >= IP_HOURLY_BACKSTOP) {
    return {
      allowed: false,
      message: "This network has reached the hourly limit for this tool. Please try again in a bit.",
    };
  }

  if ((sessionCount ?? 0) >= SESSION_HOURLY_LIMIT) {
    return {
      allowed: false,
      message: "You've reached the hourly limit for this tool on this device. Please try again in a bit.",
    };
  }

  await Promise.all([
    store.setJSON(dayKey, (dayCount ?? 0) + 1),
    store.setJSON(ipKey, (ipCount ?? 0) + 1),
    store.setJSON(sessionKey, (sessionCount ?? 0) + 1),
  ]);

  return { allowed: true };
}
