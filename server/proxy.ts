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

/** Identifies this app to upstream APIs (some block default agents). */
const USER_AGENT = "skywatch-local-dev/1.0";
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
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
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

/** Unit conversions for normalizing tar1090 feeds (ft/kt) to meters/mps. */
const FT_TO_M = 0.3048;
const KT_TO_MS = 0.514444;
const FPM_TO_MS = 0.00508;

/** Relevant subset of one tar1090-style aircraft record. */
interface TarAircraft {
  hex?: string;
  flight?: string;
  t?: string;
  r?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  gs?: number;
  track?: number;
  true_heading?: number;
  baro_rate?: number;
  geom_rate?: number;
}

/**
 * Community ADS-B aggregators (no API key). Both cap queries at a 250 nm
 * radius, so the sector is covered by sweeping {@link MOSAIC_TILES}.
 * Tiles alternate between providers to spread the load.
 */
const TAR_PROVIDERS = [
  {
    name: "airplanes.live",
    url: (lat: number, lon: number, r: number) =>
      `https://api.airplanes.live/v2/point/${lat}/${lon}/${r}`,
    listKey: "ac" as const,
  },
  {
    name: "adsb.fi",
    url: (lat: number, lon: number, r: number) =>
      `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${r}`,
    listKey: "aircraft" as const,
  },
];

/** Query radius per tile (the providers' maximum). */
const TILE_RADIUS_NM = 250;

/**
 * Circle centers `[lat, lon]` covering the busiest CONUS airspace with
 * 250 nm tiles. Sparse interior gaps (Dakotas, west Texas) are accepted.
 */
const MOSAIC_TILES: ReadonlyArray<readonly [number, number]> = [
  [47.3, -122.3], // Pacific Northwest (SEA, PDX, GEG)
  [38.5, -121.5], // Northern California (SFO, SMF, RNO)
  [34.2, -117.0], // Southern California (LAX, SAN, LAS)
  [33.8, -111.5], // Arizona (PHX, TUS)
  [40.6, -111.9], // Salt Lake (SLC, BOI edge)
  [39.7, -104.9], // Colorado (DEN, COS)
  [35.2, -106.6], // New Mexico (ABQ, ELP)
  [32.5, -97.0], // Texas (DFW, IAH, AUS, SAT, OKC)
  [30.0, -90.2], // Gulf coast (MSY, PNS, JAN)
  [39.1, -94.6], // Plains (MCI, STL, ICT, OMA)
  [44.9, -93.2], // Upper Midwest (MSP, FAR, MSN)
  [41.8, -87.8], // Great Lakes (ORD, DTW, IND, MKE)
  [36.1, -86.7], // Mid-South (BNA, MEM, SDF)
  [33.6, -84.4], // Southeast (ATL, CLT, BHM)
  [28.8, -81.5], // Florida (MCO, TPA, MIA, JAX)
  [39.0, -77.0], // Mid-Atlantic (DCA, IAD, BWI, PHL, PIT)
  [41.5, -73.5], // Northeast (JFK, LGA, EWR, BOS)
];

/** One sweep step every this many ms (~1.4 requests/s split across two
 * providers — full mosaic refresh ≈ every 12 s, matching the client poll). */
const SWEEP_INTERVAL_MS = 700;

/** Sweeping pauses when no client has polled for this long. */
const SWEEP_IDLE_AFTER_MS = 60_000;

/** Tile results older than this are dropped from the merge. */
const TILE_MAX_AGE_MS = 90_000;

interface TileResult {
  states: unknown[][];
  at: number;
}

const tileResults = new Map<number, TileResult>();
let lastClientPollAt = 0;
let sweepIndex = 0;
let warmedUp = false;

/**
 * Converts one tar1090 aircraft record into an OpenSky state-vector row,
 * the shape the client already parses. The "origin country" slot carries
 * the aircraft type and registration (e.g. `B738 · N77542`) since these
 * feeds don't provide a country.
 *
 * @param ac - Raw aircraft record.
 * @param now - Epoch seconds stamped on the row.
 * @returns A state row, or `null` when the record lacks a usable position.
 */
function toStateRow(ac: TarAircraft, now: number): unknown[] | null {
  if (typeof ac.lat !== "number" || typeof ac.lon !== "number") return null;
  const icao24 = (ac.hex ?? "").replace(/^~/, "").toLowerCase();
  if (!icao24) return null;

  const onGround = ac.alt_baro === "ground";
  const heading = ac.track ?? ac.true_heading ?? (onGround ? 0 : null);
  if (typeof heading !== "number") return null;
  const verticalRate = ac.baro_rate ?? ac.geom_rate;
  const aircraftInfo = [ac.t, ac.r].filter(Boolean).join(" · ");

  // OpenSky state-vector positions used by the client:
  // [0] icao24, [1] callsign, [2] country slot, [5] lon, [6] lat,
  // [7] baro alt (m), [8] onGround, [9] velocity (m/s),
  // [10] heading (°), [11] vertical rate (m/s)
  return [
    icao24,
    ac.flight ?? "",
    aircraftInfo,
    now,
    now,
    ac.lon,
    ac.lat,
    typeof ac.alt_baro === "number" ? ac.alt_baro * FT_TO_M : 0,
    onGround,
    typeof ac.gs === "number" ? ac.gs * KT_TO_MS : 0,
    heading,
    typeof verticalRate === "number" ? verticalRate * FPM_TO_MS : 0,
  ];
}

/**
 * Fetches one mosaic tile, trying the preferred provider first and the
 * other on failure, and stores the normalized rows.
 *
 * @param tileIndex - Index into {@link MOSAIC_TILES}.
 */
async function fetchTile(tileIndex: number): Promise<void> {
  const [lat, lon] = MOSAIC_TILES[tileIndex] as readonly [number, number];
  const order = [
    TAR_PROVIDERS[tileIndex % 2],
    TAR_PROVIDERS[(tileIndex + 1) % 2],
  ] as typeof TAR_PROVIDERS;

  for (const provider of order) {
    try {
      const result = await fetchUpstream(provider.url(lat, lon, TILE_RADIUS_NM), 15_000);
      if (!result.ok || result.body === null) continue;
      const list =
        ((result.body as Record<string, unknown>)[provider.listKey] as
          | TarAircraft[]
          | undefined) ?? [];
      const now = Math.floor(Date.now() / 1000);
      const states: unknown[][] = [];
      for (const ac of list) {
        const row = toStateRow(ac, now);
        if (row) states.push(row);
      }
      tileResults.set(tileIndex, { states, at: Date.now() });
      return;
    } catch {
      // Try the other provider, or leave the previous tile result in place.
    }
  }
}

/**
 * Background sweep: refreshes one tile per tick while clients are active.
 * The first poll after an idle period triggers a parallel warm-up of the
 * whole mosaic so the map fills within a couple of seconds.
 */
setInterval(() => {
  if (Date.now() - lastClientPollAt > SWEEP_IDLE_AFTER_MS) {
    warmedUp = false; // re-warm on the next client poll
    return;
  }
  if (!warmedUp) return; // warm-up burst in flight
  void fetchTile(sweepIndex);
  sweepIndex = (sweepIndex + 1) % MOSAIC_TILES.length;
}, SWEEP_INTERVAL_MS).unref();

/**
 * Merges all live tile results into one OpenSky-shaped payload, deduping
 * aircraft that appear in overlapping tiles.
 *
 * @param bbox - The validated request bbox; rows outside it are dropped.
 * @returns An OpenSky-shaped `{ time, states }` payload.
 */
function mergeTiles(bbox: {
  lomin: number;
  lamin: number;
  lomax: number;
  lamax: number;
}): { time: number; states: unknown[][] } {
  const byIcao = new Map<string, { row: unknown[]; at: number }>();
  const cutoff = Date.now() - TILE_MAX_AGE_MS;

  for (const tile of tileResults.values()) {
    if (tile.at < cutoff) continue;
    for (const row of tile.states) {
      const lon = row[5] as number;
      const lat = row[6] as number;
      if (lon < bbox.lomin || lon > bbox.lomax || lat < bbox.lamin || lat > bbox.lamax) {
        continue;
      }
      const icao = row[0] as string;
      const existing = byIcao.get(icao);
      if (!existing || tile.at > existing.at) {
        byIcao.set(icao, { row, at: tile.at });
      }
    }
  }

  return {
    time: Math.floor(Date.now() / 1000),
    states: [...byIcao.values()].map((e) => e.row),
  };
}

/**
 * Fetches live aircraft from OpenSky's `states/all`. Subject to strict
 * anonymous daily quotas (HTTP 429 once exhausted) — used as fallback.
 *
 * @param bbox - The validated request bbox.
 * @returns OpenSky's raw payload.
 */
async function fetchOpenSky(bbox: {
  lomin: number;
  lamin: number;
  lomax: number;
  lamax: number;
}): Promise<unknown> {
  const upstream = new URL(OPENSKY_STATES_URL);
  upstream.searchParams.set("lomin", String(bbox.lomin));
  upstream.searchParams.set("lamin", String(bbox.lamin));
  upstream.searchParams.set("lomax", String(bbox.lomax));
  upstream.searchParams.set("lamax", String(bbox.lamax));
  const result = await fetchUpstream(upstream);
  if (!result.ok || result.body === null) {
    throw new Error(`OpenSky responded with HTTP ${result.status}`);
  }
  return result.body;
}

/**
 * GET /api/flights — live state vectors inside the bbox, merged from the
 * community-feed tile mosaic. The first poll after an idle period warms
 * the whole mosaic in parallel; afterwards the background sweep keeps it
 * fresh. OpenSky is the fallback when the mosaic is empty (both
 * community providers down), and the last good payload backstops both.
 */
async function handleFlights(req: Request, res: Response): Promise<void> {
  const bbox = parseBbox(req.query.bbox);
  if (!bbox) {
    res.status(400).json({
      error: "Invalid or missing bbox. Expected bbox=lomin,lamin,lomax,lamax",
    });
    return;
  }

  lastClientPollAt = Date.now();
  const key = `flights:${bbox.lomin},${bbox.lamin},${bbox.lomax},${bbox.lamax}`;

  // One-time warm-up: fill every tile in parallel so the map populates
  // within seconds instead of one full sweep cycle.
  if (!warmedUp) {
    warmedUp = true;
    await Promise.allSettled(MOSAIC_TILES.map((_, i) => fetchTile(i)));
  }

  const merged = mergeTiles(bbox);
  if (merged.states.length > 0) {
    cache.set(key, { body: merged, storedAt: Date.now() });
    res.json(merged);
    return;
  }

  // Mosaic empty — both community providers are failing. Try OpenSky.
  try {
    const body = await fetchOpenSky(bbox);
    cache.set(key, { body, storedAt: Date.now() });
    res.json(body);
    return;
  } catch (err) {
    const stale = cache.get(key);
    if (stale) {
      // Serve the last good payload rather than erroring the client.
      res.json(stale.body);
      return;
    }
    const message = err instanceof Error ? err.message : "Unknown upstream error";
    res.status(502).json({ error: `All flight sources failed: ${message}` });
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
