/**
 * enrichment.ts — On-selection lookups for the chosen aircraft: its full
 * historical track (OpenSky, via /api/track) and its origin/destination
 * airports (adsbdb, via /api/route). Both are best-effort: failures
 * resolve to empty results and the UI falls back gracefully.
 */

import type { TrackPoint } from "./tracks";

/** One endpoint of a flight route. */
export interface RouteAirport {
  /** Display code — IATA when known, otherwise ICAO. */
  code: string;
  name: string;
  municipality: string;
  latitude: number;
  longitude: number;
}

/** Origin and destination resolved from a callsign. */
export interface FlightRoute {
  origin: RouteAirport;
  destination: RouteAirport;
}

/** Shape of one waypoint in OpenSky's tracks/all `path` array. */
type RawWaypoint = ReadonlyArray<number | boolean | null>;

/** Relevant subset of the adsbdb airport object. */
interface AdsbdbAirport {
  iata_code?: string | null;
  icao_code?: string | null;
  name?: string | null;
  municipality?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

/** Session-lifetime route cache: routes never change for a callsign. */
const routeCache = new Map<string, FlightRoute | null>();

/**
 * Fetches the historical track for an aircraft.
 *
 * @param icao24 - Aircraft identifier (6 hex chars).
 * @returns Waypoints oldest-first; empty when no track is available.
 */
export async function fetchTrack(icao24: string): Promise<TrackPoint[]> {
  try {
    const response = await fetch(`/api/track?icao24=${encodeURIComponent(icao24)}`);
    if (!response.ok) return [];
    const body = (await response.json()) as { path?: RawWaypoint[] | null };
    if (!Array.isArray(body.path)) return [];

    const points: TrackPoint[] = [];
    for (const wp of body.path) {
      const [time, lat, lon, alt] = wp;
      if (typeof lat !== "number" || typeof lon !== "number") continue;
      points.push({
        longitude: lon,
        latitude: lat,
        altitude: typeof alt === "number" ? alt : 0,
        timestamp: typeof time === "number" ? time * 1000 : 0,
      });
    }
    return points;
  } catch {
    return [];
  }
}

/**
 * Maps an adsbdb airport object to a {@link RouteAirport}.
 *
 * @param raw - Airport object from the adsbdb response.
 * @returns The mapped airport, or `null` when coordinates are missing.
 */
function toRouteAirport(raw: AdsbdbAirport | undefined): RouteAirport | null {
  if (!raw || typeof raw.latitude !== "number" || typeof raw.longitude !== "number") {
    return null;
  }
  return {
    code: raw.iata_code || raw.icao_code || "???",
    name: raw.name ?? "",
    municipality: raw.municipality ?? "",
    latitude: raw.latitude,
    longitude: raw.longitude,
  };
}

/**
 * Resolves the origin/destination airports for a callsign.
 *
 * @param callsign - The flight's callsign (may include padding spaces).
 * @returns The route, or `null` when the callsign is unknown.
 */
export async function fetchRoute(callsign: string): Promise<FlightRoute | null> {
  const cs = callsign.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(cs)) return null;

  const cached = routeCache.get(cs);
  if (cached !== undefined) return cached;

  try {
    const response = await fetch(`/api/route?callsign=${encodeURIComponent(cs)}`);
    if (!response.ok) {
      routeCache.set(cs, null);
      return null;
    }
    const body = (await response.json()) as {
      response?: { flightroute?: { origin?: AdsbdbAirport; destination?: AdsbdbAirport } };
    };
    const flightroute =
      typeof body.response === "object" ? body.response?.flightroute : undefined;
    const origin = toRouteAirport(flightroute?.origin);
    const destination = toRouteAirport(flightroute?.destination);
    const route = origin && destination ? { origin, destination } : null;
    routeCache.set(cs, route);
    return route;
  } catch {
    return null;
  }
}
