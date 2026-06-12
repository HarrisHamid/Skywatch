/**
 * motion.ts — Dead-reckoning animation between poll cycles. Each poll
 * delivers one fix per aircraft; between polls the displayed position
 * advances along the reported track at the reported ground speed, so
 * planes move continuously instead of teleporting every cycle. When the
 * next fix lands, the correction eases in over ~a second rather than
 * snapping. Extrapolation stops {@link MAX_EXTRAPOLATION_MS} past a fix
 * so a feed outage doesn't fly planes ever further off their last known
 * track.
 */

import type { FlightState } from "./flights";

/** Extrapolation horizon past the last fix (ms) — matches STALE_AFTER_MS. */
const MAX_EXTRAPOLATION_MS = 30_000;

/**
 * Time constant (ms) of the exponential ease pulling the displayed state
 * toward the extrapolated target. ~95% of a correction lands within 3τ.
 */
const EASE_TAU_MS = 350;

/** Under reduced motion the feature degrades to fixes shown verbatim. */
const reducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
).matches;

interface AnimEntry {
  /** Last reported state from the feed. */
  fix: FlightState;
  /** Epoch ms when the fix landed. */
  fixAt: number;
  /** Currently displayed (eased) position and heading. */
  longitude: number;
  latitude: number;
  heading: number;
}

const entries = new Map<string, AnimEntry>();
let lastStepAt = 0;

/** True when the animation loop should not run at all. */
export function isMotionReduced(): boolean {
  return reducedMotion;
}

/**
 * Records a fresh poll result. New aircraft start displayed exactly at
 * their fix; known aircraft keep their displayed position and ease toward
 * the new fix on subsequent {@link getDisplayFlights} calls. Aircraft
 * absent from the poll are dropped.
 *
 * @param flights - The flight set from the latest successful fetch.
 */
export function updateFixes(flights: ReadonlyArray<FlightState>): void {
  const now = Date.now();
  const seen = new Set<string>();
  for (const f of flights) {
    seen.add(f.icao24);
    const entry = entries.get(f.icao24);
    if (entry) {
      entry.fix = f;
      entry.fixAt = now;
    } else {
      entries.set(f.icao24, {
        fix: f,
        fixAt: now,
        longitude: f.longitude,
        latitude: f.latitude,
        heading: f.heading,
      });
    }
  }
  for (const key of entries.keys()) {
    if (!seen.has(key)) entries.delete(key);
  }
}

/**
 * Steps the animation and returns the flight set at displayed (animated)
 * positions. Call once per rendered frame: each call advances the eased
 * state by the wall-clock time since the previous call.
 *
 * @returns Flights with longitude/latitude/heading/altitude replaced by
 *          their animated display values; all other fields are the fix's.
 */
export function getDisplayFlights(): FlightState[] {
  const now = Date.now();
  // Cap dt so a backgrounded tab eases back over ~a second on return
  // instead of applying one huge jump... which is what easing is for.
  const dtMs = lastStepAt ? Math.min(now - lastStepAt, 500) : 0;
  lastStepAt = now;
  const alpha = reducedMotion ? 1 : 1 - Math.exp(-dtMs / EASE_TAU_MS);

  const result: FlightState[] = [];
  for (const entry of entries.values()) {
    const { fix } = entry;
    const aheadSec = reducedMotion
      ? 0
      : Math.min(now - entry.fixAt, MAX_EXTRAPOLATION_MS) / 1000;

    // Target = the fix advanced along its track. Ground returns are too
    // noisy (taxi turns, gate pushback) to be worth projecting.
    const dist = fix.onGround ? 0 : fix.velocity * aheadSec;
    const rad = (fix.heading * Math.PI) / 180;
    const cosLat = Math.cos((fix.latitude * Math.PI) / 180) || 1e-6;
    const targetLat = fix.latitude + (dist * Math.cos(rad)) / 111_320;
    const targetLon = fix.longitude + (dist * Math.sin(rad)) / (111_320 * cosLat);

    entry.longitude += (targetLon - entry.longitude) * alpha;
    entry.latitude += (targetLat - entry.latitude) * alpha;
    const dh = ((fix.heading - entry.heading + 540) % 360) - 180;
    entry.heading = (entry.heading + dh * alpha + 360) % 360;

    const altitude = fix.onGround
      ? fix.altitude
      : Math.max(fix.altitude + fix.verticalRate * aheadSec, 0);

    result.push({
      ...fix,
      longitude: entry.longitude,
      latitude: entry.latitude,
      heading: entry.heading,
      altitude,
    });
  }
  return result;
}
