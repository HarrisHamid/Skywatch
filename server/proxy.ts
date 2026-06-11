/**
 * proxy.ts — Local API proxy for the Skywatch client.
 *
 * Endpoints:
 *   GET /api/flights?bbox=lomin,lamin,lomax,lamax  → OpenSky states/all
 *   GET /api/track?icao24=abc123                   → OpenSky tracks/all
 *   GET /api/route?callsign=UAL123                 → adsbdb flight route
 *
 * All responses are cached briefly to stay polite to the upstream APIs.
 * The flights endpoint additionally falls back to the last good payload
 * when the upstream fails, so transient OpenSky outages never surface as
 * client errors.
 */

import express, { type Request, type Response } from "express";

const app = express();
const PORT = Number(process.env.PORT ?? 3001);

const OPENSKY_STATES_URL = "https://opensky-network.org/api/states/all";
const OPENSKY_TRACK_URL = "https://opensky-network.org/api/tracks/all";
const ADSBDB_CALLSIGN_URL = "https://api.adsbdb.com/v0/callsign";
const OURAIRPORTS_CSV_URL =
  "https://davidmegginson.github.io/ourairports-data/airports.csv";

/** Sector bounds for the airports endpoint (matches the client bbox). */
const SECTOR = { lomin: -130, lamin: 24, lomax: -60, lamax: 50 } as const;

/**
 * Cache TTLs per endpoint, in milliseconds. The client polls flights every
 * 12 s; caching for 10 s guarantees at most one upstream request per poll
 * cycle even with multiple tabs open. Tracks change slowly (one new
 * waypoint a minute), and routes are static for a given callsign.
 */
const TTL = {
  flights: 10_000,
  track: 60_000,
  route: 60 * 60_000,
  airports: 24 * 60 * 60_000,
} as const;

interface CacheEntry {
  body: unknown;
  storedAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Returns the cached body for a key when it is younger than `ttlMs`.
 *
 * @param key - Cache key (endpoint + normalized params).
 * @param ttlMs - Maximum acceptable age.
 * @returns The cached body, or `null` on miss/expiry.
 */
function getFresh(key: string, ttlMs: number): unknown | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.storedAt < ttlMs) return entry.body;
  return null;
}

/**
 * Fetches an upstream URL with a timeout.
 *
 * @param url - Fully built upstream URL.
 * @param timeoutMs - Abort threshold (the airports CSV is ~8 MB).
 * @returns Status and parsed JSON body (`body` is `null` on parse failure).
 */
async function fetchUpstream(
  url: URL | string,
  timeoutMs = 10_000
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Non-JSON upstream body (e.g. rate-limit text); treated as null.
    }
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parses a `bbox` query string of the form `lomin,lamin,lomax,lamax`
 * (the order used by the client: `-130,24,-60,50`) into the four named
 * coordinates OpenSky expects. Returns `null` when the value is missing,
 * malformed, or out of range.
 *
 * @param raw - The raw `bbox` query parameter.
 * @returns Named bounding-box coordinates, or `null` if invalid.
 */
export function parseBbox(
  raw: unknown
): { lomin: number; lamin: number; lomax: number; lamax: number } | null {
  if (typeof raw !== "string") return null;
  const parts = raw.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return null;

  const [lomin, lamin, lomax, lamax] = parts as [number, number, number, number];
  const lonOk = (lon: number) => lon >= -180 && lon <= 180;
  const latOk = (lat: number) => lat >= -90 && lat <= 90;
  if (!lonOk(lomin) || !lonOk(lomax) || !latOk(lamin) || !latOk(lamax)) {
    return null;
  }
  if (lomin >= lomax || lamin >= lamax) return null;

  return { lomin, lamin, lomax, lamax };
}

/**
 * GET /api/flights — live state vectors inside the bbox. On upstream
 * failure the last good payload (any age) is served instead, so the
 * client keeps rendering and merely shows its staleness indicator.
 */
async function handleFlights(req: Request, res: Response): Promise<void> {
  const bbox = parseBbox(req.query.bbox);
  if (!bbox) {
    res.status(400).json({
      error: "Invalid or missing bbox. Expected bbox=lomin,lamin,lomax,lamax",
    });
    return;
  }

  const key = `flights:${bbox.lomin},${bbox.lamin},${bbox.lomax},${bbox.lamax}`;
  const fresh = getFresh(key, TTL.flights);
  if (fresh) {
    res.json(fresh);
    return;
  }

  const upstream = new URL(OPENSKY_STATES_URL);
  upstream.searchParams.set("lomin", String(bbox.lomin));
  upstream.searchParams.set("lamin", String(bbox.lamin));
  upstream.searchParams.set("lomax", String(bbox.lomax));
  upstream.searchParams.set("lamax", String(bbox.lamax));

  try {
    const result = await fetchUpstream(upstream);
    if (!result.ok || result.body === null) {
      throw new Error(`OpenSky responded with HTTP ${result.status}`);
    }
    cache.set(key, { body: result.body, storedAt: Date.now() });
    res.json(result.body);
  } catch (err) {
    const stale = cache.get(key);
    if (stale) {
      // Serve the last good payload rather than erroring the client.
      res.json(stale.body);
      return;
    }
    const message = err instanceof Error ? err.message : "Unknown upstream error";
    res.status(502).json({ error: `Failed to reach OpenSky: ${message}` });
  }
}

/**
 * GET /api/track — full track (historical waypoints) for one aircraft.
 * Missing tracks are a normal condition (OpenSky only has them for some
 * flights) and return 404; the client falls back to live breadcrumbs.
 */
async function handleTrack(req: Request, res: Response): Promise<void> {
  const icao24 = String(req.query.icao24 ?? "").toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(icao24)) {
    res.status(400).json({ error: "Invalid icao24. Expected 6 hex characters." });
    return;
  }

  const key = `track:${icao24}`;
  const fresh = getFresh(key, TTL.track);
  if (fresh) {
    res.json(fresh);
    return;
  }

  const upstream = new URL(OPENSKY_TRACK_URL);
  upstream.searchParams.set("icao24", icao24);
  upstream.searchParams.set("time", "0");

  try {
    const result = await fetchUpstream(upstream);
    if (!result.ok || result.body === null) {
      res.status(404).json({ error: `No track available (HTTP ${result.status})` });
      return;
    }
    cache.set(key, { body: result.body, storedAt: Date.now() });
    res.json(result.body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown upstream error";
    res.status(502).json({ error: `Failed to reach OpenSky: ${message}` });
  }
}

/**
 * GET /api/route — origin/destination airports for a callsign, via the
 * free adsbdb.com database. Unknown callsigns return 404.
 */
async function handleRoute(req: Request, res: Response): Promise<void> {
  const callsign = String(req.query.callsign ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(callsign)) {
    res.status(400).json({ error: "Invalid callsign." });
    return;
  }

  const key = `route:${callsign}`;
  const fresh = getFresh(key, TTL.route);
  if (fresh) {
    res.json(fresh);
    return;
  }

  try {
    const result = await fetchUpstream(`${ADSBDB_CALLSIGN_URL}/${callsign}`);
    if (!result.ok || result.body === null) {
      res.status(404).json({ error: `Route unknown (HTTP ${result.status})` });
      return;
    }
    cache.set(key, { body: result.body, storedAt: Date.now() });
    res.json(result.body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown upstream error";
    res.status(502).json({ error: `Failed to reach adsbdb: ${message}` });
  }
}

/**
 * Parses one CSV line, honoring double-quoted fields with embedded commas
 * and escaped quotes (`""`).
 *
 * @param line - A single CSV record.
 * @returns The field values.
 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/** One airport served to the client. */
interface ServedAirport {
  iata: string;
  name: string;
  municipality: string;
  latitude: number;
  longitude: number;
  /** 1 = large airport (always labeled), 2 = medium (labeled when zoomed). */
  rank: 1 | 2;
}

/**
 * GET /api/airports — every large airport plus every medium airport with
 * scheduled service inside the sector, from the OurAirports open dataset.
 * The ~8 MB CSV is fetched once and the filtered result cached for a day.
 *
 * CSV columns used: [2] type, [3] name, [4] lat, [5] lon,
 * [10] municipality, [11] scheduled_service, [13] iata_code.
 */
async function handleAirports(_req: Request, res: Response): Promise<void> {
  const key = "airports";
  const fresh = getFresh(key, TTL.airports);
  if (fresh) {
    res.json(fresh);
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const response = await fetch(OURAIRPORTS_CSV_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) {
      throw new Error(`OurAirports responded with HTTP ${response.status}`);
    }
    const csv = await response.text();

    const airports: ServedAirport[] = [];
    const lines = csv.split("\n");
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const f = parseCsvLine(line);
      const type = f[2];
      if (type !== "large_airport" && type !== "medium_airport") continue;
      if (type === "medium_airport" && f[11] !== "yes") continue;
      const iata = (f[13] ?? "").trim();
      if (!iata) continue;
      const latitude = Number(f[4]);
      const longitude = Number(f[5]);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
      if (
        longitude < SECTOR.lomin ||
        longitude > SECTOR.lomax ||
        latitude < SECTOR.lamin ||
        latitude > SECTOR.lamax
      ) {
        continue;
      }
      airports.push({
        iata,
        name: f[3] ?? "",
        municipality: f[10] ?? "",
        latitude,
        longitude,
        rank: type === "large_airport" ? 1 : 2,
      });
    }

    const body = { airports };
    cache.set(key, { body, storedAt: Date.now() });
    res.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown upstream error";
    res.status(502).json({ error: `Failed to load airports: ${message}` });
  }
}

app.get("/api/flights", handleFlights);
app.get("/api/track", handleTrack);
app.get("/api/route", handleRoute);
app.get("/api/airports", handleAirports);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[skywatch] API proxy listening on http://localhost:${PORT}`);
});
