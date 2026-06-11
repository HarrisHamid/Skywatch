/**
 * flights.ts — FlightState model, OpenSky fetcher, and polling loop.
 *
 * Raw OpenSky state vectors are positional arrays. The indices used here:
 *   [0] icao24, [1] callsign, [2] originCountry, [5] longitude,
 *   [6] latitude, [7] baro altitude (m), [8] onGround,
 *   [9] velocity (m/s), [10] true track / heading (°), [11] vertical rate (m/s)
 */

/** A single live aircraft state, normalized from an OpenSky state vector. */
export interface FlightState {
  icao24: string;
  callsign: string;
  originCountry: string;
  longitude: number;
  latitude: number;
  /** Barometric altitude in meters. */
  altitude: number;
  /** Ground speed in meters per second. */
  velocity: number;
  /** True track in degrees clockwise from north. */
  heading: number;
  /** Vertical rate in meters per second (positive = climbing). */
  verticalRate: number;
  onGround: boolean;
}

/** Shape of the JSON body returned by OpenSky's `states/all` endpoint. */
interface OpenSkyResponse {
  time: number;
  states: ReadonlyArray<ReadonlyArray<string | number | boolean | null>> | null;
}

/** Bounding box covering the continental United States (lomin,lamin,lomax,lamax). */
export const BBOX = "-130,24,-60,50";

/** Client poll cadence in milliseconds. */
export const POLL_INTERVAL_MS = 12_000;

/**
 * Converts a single raw OpenSky state vector into a typed {@link FlightState}.
 * Vectors missing a position, heading, or identifier are rejected because
 * they cannot be rendered on the map.
 *
 * @param raw - One positional state array from `states/all`.
 * @returns A normalized flight, or `null` when required fields are absent.
 */
export function parseState(
  raw: ReadonlyArray<string | number | boolean | null>
): FlightState | null {
  const icao24 = raw[0];
  const callsign = raw[1];
  const originCountry = raw[2];
  const longitude = raw[5];
  const latitude = raw[6];
  const altitude = raw[7];
  const onGround = raw[8];
  const velocity = raw[9];
  const heading = raw[10];
  const verticalRate = raw[11];

  if (typeof icao24 !== "string" || icao24.length === 0) return null;
  if (typeof longitude !== "number" || typeof latitude !== "number") return null;
  if (typeof heading !== "number") return null;

  return {
    icao24,
    callsign: typeof callsign === "string" ? callsign.trim() : "",
    originCountry: typeof originCountry === "string" ? originCountry : "Unknown",
    longitude,
    latitude,
    altitude: typeof altitude === "number" ? altitude : 0,
    velocity: typeof velocity === "number" ? velocity : 0,
    heading,
    verticalRate: typeof verticalRate === "number" ? verticalRate : 0,
    onGround: onGround === true,
  };
}

/**
 * Fetches the current flight set from the local proxy (`/api/flights`)
 * and maps it to typed {@link FlightState} records.
 *
 * @param signal - Optional abort signal to cancel an in-flight request.
 * @returns All parseable flights inside {@link BBOX}.
 * @throws Error when the network request fails or the proxy returns non-2xx.
 */
export async function fetchFlights(signal?: AbortSignal): Promise<FlightState[]> {
  const response = await fetch(`/api/flights?bbox=${BBOX}`, signal ? { signal } : {});
  if (!response.ok) {
    throw new Error(`Flight feed returned HTTP ${response.status}`);
  }

  const body = (await response.json()) as OpenSkyResponse;
  if (!body.states) return [];

  const flights: FlightState[] = [];
  for (const raw of body.states) {
    const flight = parseState(raw);
    if (flight) flights.push(flight);
  }
  return flights;
}

/** Callbacks invoked by {@link startPolling} on each poll cycle. */
export interface PollerCallbacks {
  /** Called with a fresh flight set after every successful fetch. */
  onData: (flights: FlightState[]) => void;
  /** Called when a fetch attempt fails; polling continues afterwards. */
  onError: (error: Error) => void;
}

/**
 * Starts the 12-second polling loop. Fetches immediately, then on every
 * interval tick. A failed cycle reports through `onError` but never stops
 * the loop — the next tick retries automatically.
 *
 * @param callbacks - Data and error handlers for each cycle.
 * @returns A cleanup function that stops the loop and aborts any
 *          in-flight request.
 */
export function startPolling(callbacks: PollerCallbacks): () => void {
  let stopped = false;
  let controller: AbortController | null = null;

  const tick = async (): Promise<void> => {
    controller?.abort();
    controller = new AbortController();
    try {
      const flights = await fetchFlights(controller.signal);
      if (!stopped) callbacks.onData(flights);
    } catch (err) {
      if (stopped || (err instanceof DOMException && err.name === "AbortError")) {
        return;
      }
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  void tick();
  const interval = window.setInterval(() => void tick(), POLL_INTERVAL_MS);

  return () => {
    stopped = true;
    window.clearInterval(interval);
    controller?.abort();
  };
}
