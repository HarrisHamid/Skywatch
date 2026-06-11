/**
 * tracks.ts — Per-aircraft position history used to draw flight trails.
 * Live breadcrumbs accumulate from poll cycles; selecting an aircraft
 * additionally seeds its full historical track fetched from the server
 * (see enrichment.ts), so the trail appears instantly.
 */

import type { FlightState } from "./flights";

/** One recorded waypoint along an aircraft's track. */
export interface TrackPoint {
  longitude: number;
  latitude: number;
  /** Barometric altitude in meters at this waypoint. */
  altitude: number;
  /** Epoch ms of the waypoint. */
  timestamp: number;
}

/** Maximum waypoints retained per aircraft (full flights stay intact). */
const MAX_POINTS = 600;

/** Tracks for aircraft unseen this long (ms) are dropped. */
const EXPIRE_AFTER_MS = 5 * 60_000;

interface TrackEntry {
  points: TrackPoint[];
  lastSeen: number;
}

const tracks = new Map<string, TrackEntry>();

/**
 * Appends the current position of every flight to its track history and
 * expires tracks for aircraft that have left the sector.
 *
 * @param flights - The freshly fetched flight set.
 */
export function recordTracks(flights: ReadonlyArray<FlightState>): void {
  const now = Date.now();

  for (const flight of flights) {
    let entry = tracks.get(flight.icao24);
    if (!entry) {
      entry = { points: [], lastSeen: now };
      tracks.set(flight.icao24, entry);
    }
    entry.lastSeen = now;

    const last = entry.points[entry.points.length - 1];
    if (
      !last ||
      last.longitude !== flight.longitude ||
      last.latitude !== flight.latitude
    ) {
      entry.points.push({
        longitude: flight.longitude,
        latitude: flight.latitude,
        altitude: flight.altitude,
        timestamp: now,
      });
      if (entry.points.length > MAX_POINTS) entry.points.shift();
    }
  }

  for (const [icao, entry] of tracks) {
    if (now - entry.lastSeen > EXPIRE_AFTER_MS) tracks.delete(icao);
  }
}

/**
 * Seeds an aircraft's track with historical waypoints fetched from the
 * server, keeping any live breadcrumbs newer than the history's end.
 *
 * @param icao24 - Aircraft identifier.
 * @param history - Waypoints sorted oldest-first.
 */
export function seedTrack(icao24: string, history: TrackPoint[]): void {
  if (history.length === 0) return;

  let entry = tracks.get(icao24);
  if (!entry) {
    entry = { points: [], lastSeen: Date.now() };
    tracks.set(icao24, entry);
  }

  const historyEnd = history[history.length - 1]?.timestamp ?? 0;
  const liveTail = entry.points.filter((p) => p.timestamp > historyEnd);
  entry.points = [...history, ...liveTail].slice(-MAX_POINTS);
}

/**
 * Returns the recorded trail for an aircraft (oldest first).
 *
 * @param icao24 - Aircraft identifier.
 * @returns The track points, or an empty array when none are recorded.
 */
export function getTrack(icao24: string): ReadonlyArray<TrackPoint> {
  return tracks.get(icao24)?.points ?? [];
}
