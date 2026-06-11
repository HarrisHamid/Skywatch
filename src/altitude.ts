/**
 * altitude.ts — Altitude color ramp and aviation unit conversions, shared
 * by the Deck.gl layers, the dashboard list, and the telemetry panel.
 */

/** Meters → feet. */
export const M_TO_FT = 3.28084;

/** Meters/second → knots. */
export const MS_TO_KT = 1.94384;

/** Meters/second → feet/minute (vertical speed). */
export const MS_TO_FPM = 196.85;

export type RGB = [number, number, number];

/** Color for aircraft reported on the ground. */
const GROUND_COLOR: RGB = [122, 143, 168];

/**
 * Altitude ramp stops in meters: low traffic glows amber, mid-altitude
 * shifts through mint, cruise traffic reads in the signature cyan.
 */
const STOPS: ReadonlyArray<readonly [number, RGB]> = [
  [0, [240, 165, 0]],
  [5500, [150, 225, 130]],
  [11000, [0, 240, 220]],
];

/**
 * Maps a barometric altitude to the amber→mint→cyan ramp.
 *
 * @param altitudeM - Barometric altitude in meters.
 * @param onGround - Ground traffic renders in a muted slate instead.
 * @returns RGB triple for tinting glyphs and list rows.
 */
export function altitudeColor(altitudeM: number, onGround: boolean): RGB {
  if (onGround) return GROUND_COLOR;

  const first = STOPS[0] as readonly [number, RGB];
  const last = STOPS[STOPS.length - 1] as readonly [number, RGB];
  if (altitudeM >= last[0]) return [...last[1]] as RGB;
  if (altitudeM <= first[0]) return [...first[1]] as RGB;

  for (let i = 1; i < STOPS.length; i++) {
    const [hi, hiColor] = STOPS[i] as readonly [number, RGB];
    if (altitudeM <= hi) {
      const [lo, loColor] = STOPS[i - 1] as readonly [number, RGB];
      const t = (altitudeM - lo) / (hi - lo);
      return [
        Math.round(loColor[0] + (hiColor[0] - loColor[0]) * t),
        Math.round(loColor[1] + (hiColor[1] - loColor[1]) * t),
        Math.round(loColor[2] + (hiColor[2] - loColor[2]) * t),
      ];
    }
  }
  return [...last[1]] as RGB;
}

/**
 * Formats an altitude in meters as a feet string, e.g. `34,975`.
 */
export function formatFeet(altitudeM: number): string {
  return Math.round(altitudeM * M_TO_FT).toLocaleString("en-US");
}

/**
 * Formats a ground speed in m/s as whole knots, e.g. `447`.
 */
export function formatKnots(velocityMs: number): string {
  return String(Math.round(velocityMs * MS_TO_KT));
}
