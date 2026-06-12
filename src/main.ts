/**
 * main.ts — App bootstrap: Mapbox base map, Deck.gl MapboxOverlay, the
 * full flight layer stack (trails, leader lines, plane glyphs, airports),
 * hover tooltips, dashboard + telemetry panel wiring, and the poll loop.
 */

import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
// NOTE: line-like visuals use PathLayer, not LineLayer — LineLayer (like
// IconLayer/TextLayer) silently renders nothing under MapboxOverlay on
// this GPU/driver combination. PathLayer and the other layers used here
// are verified working.
import {
  ScatterplotLayer,
  SolidPolygonLayer,
  PathLayer,
} from "@deck.gl/layers";
import type { Layer, PickingInfo } from "@deck.gl/core";

import { startPolling, type FlightState } from "./flights";
import { loadAirports, type Airport } from "./airports";
import { altitudeColor, formatFeet, formatKnots } from "./altitude";
import { recordTracks, getTrack, seedTrack, type TrackPoint } from "./tracks";
import { fetchTrack, fetchRoute, type FlightRoute } from "./enrichment";
import { initPanel, showFlight, showRoute, hidePanel } from "./panel";
import { initDashboard, updateDashboard } from "./dashboard";
import { initGlobe } from "./globe";
import "./styles.css";

// ─── Design tokens (mirrors styles.css :root) ────────────────────────────────
const ACCENT_CYAN: [number, number, number, number] = [0, 240, 220, 255];

/** Data older than this (ms) is treated as stale (dimmed glyphs, amber chip). */
const STALE_AFTER_MS = 30_000;

/** Leader lines project this many seconds of travel ahead of each aircraft. */
const LEADER_SECONDS = 75;

/**
 * Top-down airliner silhouette (nose up) as a unit polygon: x spans the
 * wings, y runs tail→nose, both roughly in [-0.5, 0.5]. Rendered with
 * SolidPolygonLayer because texture-backed layers (IconLayer/TextLayer)
 * fail to draw under MapboxOverlay on some GPU/driver combinations —
 * plain geometry always works.
 */
const PLANE_OUTLINE: ReadonlyArray<readonly [number, number]> = [
  [0, 0.484], // nose
  [0.047, 0.367],
  [0.053, 0.156],
  [0.453, -0.055], // right wingtip
  [0.453, -0.148],
  [0.053, -0.023],
  [0.041, -0.25],
  [0.148, -0.336], // right stabilizer
  [0.148, -0.398],
  [0, -0.352], // tail
  [-0.148, -0.398],
  [-0.148, -0.336], // left stabilizer
  [-0.041, -0.25],
  [-0.053, -0.023],
  [-0.453, -0.148],
  [-0.453, -0.055], // left wingtip
  [-0.053, 0.156],
  [-0.047, 0.367],
];

/**
 * On-screen plane glyph length in pixels for the current zoom: smaller at
 * continental zooms so dense airspace stays readable, larger up close.
 */
function planeSizePx(zoom: number): number {
  return Math.min(Math.max(6 + 2.2 * zoom, 13), 26);
}

/** Web-mercator circumference used for the meters-per-pixel estimate. */
const EARTH_CIRCUMFERENCE_M = 40_075_016.686;

/**
 * Builds the rotated, pixel-sized silhouette polygon for one aircraft.
 * The unit outline is rotated clockwise by the heading, scaled from
 * pixels to meters using the current zoom, then offset to the aircraft's
 * coordinates.
 *
 * @param d - The flight to draw.
 * @param zoom - Current map zoom (polygons are rebuilt on zoom changes).
 * @param sizePx - Desired on-screen glyph length in pixels.
 * @returns A closed polygon ring in `[longitude, latitude]` pairs.
 */
function planePolygon(
  d: FlightState,
  zoom: number,
  sizePx: number
): Array<[number, number]> {
  const latRad = (d.latitude * Math.PI) / 180;
  const cosLat = Math.max(Math.cos(latRad), 1e-6);
  const metersPerPixel = (EARTH_CIRCUMFERENCE_M * cosLat) / (512 * 2 ** zoom);
  const sizeM = sizePx * metersPerPixel;

  const h = (d.heading * Math.PI) / 180;
  const sinH = Math.sin(h);
  const cosH = Math.cos(h);

  return PLANE_OUTLINE.map(([ux, uy]) => {
    const eastM = (ux * cosH + uy * sinH) * sizeM;
    const northM = (-ux * sinH + uy * cosH) * sizeM;
    return [
      d.longitude + eastM / (111_320 * cosLat),
      d.latitude + northM / 110_540,
    ] as [number, number];
  });
}

// ─── Mutable app state ────────────────────────────────────────────────────────
let flights: FlightState[] = [];
let lastUpdateAt = 0;
let selectedIcao: string | null = null;
let selectedRoute: FlightRoute | null = null;
let firstDataArrived = false;
let consecutiveFeedErrors = 0;
let showPlanes = true;

const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;

/**
 * Returns true when the most recent successful fetch is older than
 * {@link STALE_AFTER_MS}, or when no data has arrived at all.
 */
export function isDataStale(): boolean {
  return Date.now() - lastUpdateAt > STALE_AFTER_MS;
}

/**
 * Projects a flight's position {@link LEADER_SECONDS} ahead along its
 * current track — the tip of its leader line.
 *
 * @param d - The flight to project.
 * @returns `[longitude, latitude]` of the projected point.
 */
function leaderTip(d: FlightState): [number, number] {
  const rad = (d.heading * Math.PI) / 180;
  const dist = d.velocity * LEADER_SECONDS;
  const dLat = (dist * Math.cos(rad)) / 111_320;
  const cosLat = Math.cos((d.latitude * Math.PI) / 180) || 1e-6;
  const dLon = (dist * Math.sin(rad)) / (111_320 * cosLat);
  return [d.longitude + dLon, d.latitude + dLat];
}

/**
 * Builds the Deck.gl layer stack: the selected flight's breadcrumb trail,
 * leader lines projecting each aircraft's travel, a selection ring, and
 * the rotated plane silhouettes on top. Airports render as native Mapbox
 * layers underneath (see {@link addAirportLayers}).
 *
 * @returns Layers ready to hand to `MapboxOverlay.setProps`.
 */
function buildLayers(): Layer[] {
  // Aircraft hidden by the toggle — airports stay (they're Mapbox layers).
  if (!showPlanes) return [];

  const stale = isDataStale();
  const alpha = stale ? 140 : 255;
  const zoom = map.getZoom();
  const selected = selectedIcao
    ? flights.find((f) => f.icao24 === selectedIcao) ?? null
    : null;
  const trail = selectedIcao ? getTrack(selectedIcao) : [];

  // The trail renders as per-segment lines so each leg can carry the
  // altitude color of the aircraft at that point in the flight.
  interface TrailSegment {
    from: TrackPoint;
    to: TrackPoint;
  }
  const trailSegments: TrailSegment[] = [];
  for (let i = 1; i < trail.length; i++) {
    trailSegments.push({
      from: trail[i - 1] as TrackPoint,
      to: trail[i] as TrackPoint,
    });
  }
  // Connect the trail's end to the live aircraft position.
  if (selected && trail.length > 0) {
    const lastPoint = trail[trail.length - 1] as TrackPoint;
    trailSegments.push({
      from: lastPoint,
      to: {
        longitude: selected.longitude,
        latitude: selected.latitude,
        altitude: selected.altitude,
        timestamp: Date.now(),
      },
    });
  }

  const segmentPath = (d: TrailSegment): [number, number][] => [
    [d.from.longitude, d.from.latitude],
    [d.to.longitude, d.to.latitude],
  ];

  // Two passes: a wide translucent glow underneath a bright core, so the
  // trail stands out against dense traffic.
  const trailGlow = new PathLayer<TrailSegment>({
    id: "flight-trail-glow",
    data: trailSegments,
    getPath: segmentPath,
    getColor: (d) => [...altitudeColor(d.to.altitude, false), 70],
    getWidth: 8,
    widthUnits: "pixels",
    widthMinPixels: 8,
    capRounded: true,
  });

  const trailLayer = new PathLayer<TrailSegment>({
    id: "flight-trail",
    data: trailSegments,
    getPath: segmentPath,
    getColor: (d) => [...altitudeColor(d.to.altitude, false), 240],
    getWidth: 3,
    widthUnits: "pixels",
    widthMinPixels: 3,
    capRounded: true,
  });

  // Faint guide lines from the route's origin airport to the aircraft and
  // onward to its destination (when the route lookup resolved).
  interface RouteLeg {
    source: [number, number];
    target: [number, number];
  }
  const routeLegs: RouteLeg[] = [];
  if (selected && selectedRoute) {
    routeLegs.push(
      {
        source: [selectedRoute.origin.longitude, selectedRoute.origin.latitude],
        target: [selected.longitude, selected.latitude],
      },
      {
        source: [selected.longitude, selected.latitude],
        target: [
          selectedRoute.destination.longitude,
          selectedRoute.destination.latitude,
        ],
      }
    );
  }

  const routeLayer = new PathLayer<RouteLeg>({
    id: "route-legs",
    data: routeLegs,
    getPath: (d) => [d.source, d.target],
    getColor: [0, 240, 220, 70],
    getWidth: 1.5,
    widthUnits: "pixels",
    widthMinPixels: 1.5,
  });

  const leaderLines = new PathLayer<FlightState>({
    id: "flight-leaders",
    data: flights,
    getPath: (d) => [[d.longitude, d.latitude], leaderTip(d)],
    getColor: (d) => [...altitudeColor(d.altitude, d.onGround), stale ? 60 : 120],
    getWidth: 1,
    widthUnits: "pixels",
    widthMinPixels: 1,
    updateTriggers: { getColor: [stale] },
  });

  const selectionRing = new ScatterplotLayer<FlightState>({
    id: "selection-ring",
    data: selected ? [selected] : [],
    getPosition: (d) => [d.longitude, d.latitude],
    getRadius: 20,
    radiusUnits: "pixels",
    stroked: true,
    filled: false,
    getLineColor: ACCENT_CYAN,
    getLineWidth: 1.5,
    lineWidthUnits: "pixels",
  });

  const planeLayer = new SolidPolygonLayer<FlightState>({
    id: "flight-planes",
    data: flights,
    getPolygon: (d) =>
      planePolygon(
        d,
        zoom,
        d.icao24 === selectedIcao ? planeSizePx(zoom) * 1.4 : planeSizePx(zoom)
      ),
    getFillColor: (d) => [...altitudeColor(d.altitude, d.onGround), alpha],
    filled: true,
    extruded: false,
    pickable: true,
    onClick: handleFlightClick,
    onHover: handleHover,
    updateTriggers: {
      getFillColor: [stale],
      getPolygon: [zoom, selectedIcao],
    },
  });

  return [
    routeLayer,
    trailGlow,
    trailLayer,
    leaderLines,
    selectionRing,
    planeLayer,
  ];
}

/**
 * Selects a flight (from a map click or a dashboard row), opens the
 * telemetry panel, kicks off the track/route lookups, and repaints.
 *
 * @param flight - The aircraft to select.
 */
function selectFlight(flight: FlightState): void {
  const changed = selectedIcao !== flight.icao24;
  selectedIcao = flight.icao24;
  showFlight(flight);
  if (changed) {
    selectedRoute = null;
    showRoute(undefined); // "looking up route…"
    void enrichSelection(flight);
  }
  redraw();
  refreshDashboard();
}

/**
 * Fetches the historical track and origin/destination route for the
 * newly selected aircraft, then repaints. Results arriving after the
 * selection has moved on are discarded.
 *
 * @param flight - The aircraft that was just selected.
 */
async function enrichSelection(flight: FlightState): Promise<void> {
  const icao = flight.icao24;
  const [track, route] = await Promise.all([
    fetchTrack(icao),
    fetchRoute(flight.callsign),
  ]);
  if (selectedIcao !== icao) return;

  if (track.length > 0) seedTrack(icao, track);
  selectedRoute = route;
  showRoute(route);
  redraw();
}

/**
 * Clears the current selection and its route/trail overlays.
 */
function clearSelection(): void {
  selectedIcao = null;
  selectedRoute = null;
  hidePanel();
  redraw();
  refreshDashboard();
}

/**
 * Handles a click on a plane glyph.
 *
 * @param info - Deck.gl picking info; `object` is the clicked flight.
 * @returns `true` to mark the event handled.
 */
function handleFlightClick(info: PickingInfo<FlightState>): boolean {
  if (!info.object) return false;
  selectFlight(info.object);
  return true;
}

/**
 * Shows the floating tooltip with the given content at a screen position,
 * or hides it when `html` is null.
 *
 * @param html - Inner HTML for the tooltip, or `null` to hide it.
 * @param x - Cursor x in CSS pixels.
 * @param y - Cursor y in CSS pixels.
 */
function setTooltip(html: string | null, x = 0, y = 0): void {
  const tooltip = document.getElementById("tooltip");
  if (!tooltip) return;
  if (!html) {
    tooltip.classList.remove("tooltip--visible");
    map.getCanvas().style.cursor = "";
    return;
  }
  tooltip.innerHTML = html;
  tooltip.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
  tooltip.classList.add("tooltip--visible");
  map.getCanvas().style.cursor = "pointer";
}

/**
 * Escapes text destined for tooltip innerHTML.
 */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Deck.gl hover handler for plane glyphs.
 *
 * @param info - Picking info; `object` is the hovered flight.
 */
function handleHover(info: PickingInfo<FlightState>): void {
  const f = info.object;
  if (!f) {
    setTooltip(null);
    return;
  }
  setTooltip(
    `<p class="tooltip__title">${escapeHtml(f.callsign || f.icao24.toUpperCase())}</p>
     <p class="tooltip__line">${f.onGround ? "ON GROUND" : `${formatFeet(f.altitude)} FT`}
       · ${formatKnots(f.velocity)} KT
       · HDG ${f.heading.toFixed(0).padStart(3, "0")}°</p>`,
    info.x,
    info.y
  );
}

/**
 * Adds the airport waypoints as native Mapbox layers: slate dots plus
 * IATA code labels. Mapbox's own glyph pipeline renders the text
 * (deck.gl's TextLayer cannot be relied on here — see PLANE_OUTLINE note),
 * and Mapbox handles label collision for free. Major hubs (rank 1) are
 * always labeled; regional airports (rank 2) appear from zoom 5.5 so the
 * national view stays clean. Hovering shows the airport name; the
 * runway/taxiway layout appears from the base style as you zoom in.
 *
 * @param airports - The full airport set to plot.
 */
function addAirportLayers(airports: ReadonlyArray<Airport>): void {
  const geojson = {
    type: "FeatureCollection" as const,
    features: airports.map((a) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [a.longitude, a.latitude] },
      properties: {
        iata: a.iata,
        name: a.name,
        municipality: a.municipality ?? "",
        rank: a.rank ?? 1,
      },
    })),
  };

  map.addSource("airports", { type: "geojson", data: geojson });

  const dotPaint = (opacity: number) => ({
    "circle-color": "#8fa8c4",
    "circle-opacity": opacity,
    "circle-stroke-width": 1,
    "circle-stroke-color": "#8fa8c4",
    "circle-stroke-opacity": Math.min(opacity + 0.3, 1),
  });

  const labelLayout = (size: number, allowOverlap: boolean) => ({
    "text-field": ["get", "iata"] as [string, string],
    "text-font": ["DIN Pro Medium", "Arial Unicode MS Regular"],
    "text-size": size,
    "text-offset": [0, -1.1] as [number, number],
    "text-letter-spacing": 0.15,
    "text-allow-overlap": allowOverlap,
  });

  const labelPaint = (color: string) => ({
    "text-color": color,
    "text-halo-color": "#000000",
    "text-halo-width": 1.2,
  });

  map.addLayer({
    id: "airport-dots-major",
    type: "circle",
    source: "airports",
    filter: ["==", ["get", "rank"], 1],
    paint: { "circle-radius": 3.5, ...dotPaint(0.65) },
  });
  map.addLayer({
    id: "airport-codes-major",
    type: "symbol",
    source: "airports",
    filter: ["==", ["get", "rank"], 1],
    layout: labelLayout(10.5, true),
    paint: labelPaint("#a8c0d8"),
  });

  map.addLayer({
    id: "airport-dots-minor",
    type: "circle",
    source: "airports",
    filter: ["==", ["get", "rank"], 2],
    minzoom: 5.5,
    paint: { "circle-radius": 2.5, ...dotPaint(0.45) },
  });
  map.addLayer({
    id: "airport-codes-minor",
    type: "symbol",
    source: "airports",
    filter: ["==", ["get", "rank"], 2],
    minzoom: 5.5,
    layout: labelLayout(9.5, false),
    paint: labelPaint("#7a8fa8"),
  });

  const hoverLayers = [
    "airport-dots-major",
    "airport-codes-major",
    "airport-dots-minor",
    "airport-codes-minor",
  ];
  for (const layerId of hoverLayers) {
    map.on("mousemove", layerId, (e) => {
      const feature = e.features?.[0];
      if (!feature) return;
      const { iata, name, municipality } = feature.properties as {
        iata: string;
        name: string;
        municipality: string;
      };
      const place = municipality ? `${municipality} — ` : "";
      setTooltip(
        `<p class="tooltip__title">${escapeHtml(iata)}</p>
         <p class="tooltip__line">${escapeHtml(place + name)} — zoom in for field layout</p>`,
        e.point.x,
        e.point.y
      );
    });
    map.on("mouseleave", layerId, () => setTooltip(null));
  }
}

/**
 * Shows the bottom-left error toast for a few seconds.
 *
 * @param message - Human-readable error text.
 */
export function showToast(message: string): void {
  const toast = document.getElementById("toast");
  if (!toast) return;
  const body = toast.querySelector<HTMLElement>(".toast__message");
  if (body) body.textContent = message;
  toast.classList.add("toast--visible");
  window.setTimeout(() => toast.classList.remove("toast--visible"), 5000);
}

/**
 * Removes the initial loading skeleton once the first dataset lands.
 */
function dismissSkeleton(): void {
  document.getElementById("skeleton")?.classList.add("skeleton--hidden");
}

/**
 * Pushes the current fleet snapshot into the dashboard.
 */
function refreshDashboard(): void {
  updateDashboard(flights, selectedIcao, isDataStale());
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
const appEl = document.getElementById("app");
if (!appEl) throw new Error("Missing #app root element");

initPanel(appEl, () => clearSelection());

if (!mapboxToken) {
  showToast("VITE_MAPBOX_TOKEN is not set — see README. Map cannot load.");
  throw new Error("VITE_MAPBOX_TOKEN missing");
}
mapboxgl.accessToken = mapboxToken;

const map = new mapboxgl.Map({
  container: "map",
  style: "mapbox://styles/mapbox/dark-v11",
  center: [-96, 38],
  zoom: 4,
  // Mapbox v3 defaults to the 3D globe projection at low zooms, but the
  // Deck.gl overlay projects flat mercator — the two drift apart when
  // zoomed out. Pinning mercator keeps every layer aligned at all zooms.
  projection: "mercator",
  attributionControl: true,
});

initDashboard(appEl, {
  onSelect: (flight) => {
    selectFlight(flight);
    map.flyTo({
      center: [flight.longitude, flight.latitude],
      zoom: Math.max(map.getZoom(), 7),
      duration: 1400,
    });
  },
});

/**
 * Opacity applied to the Mapbox style's background layers. dark-v11 ships
 * fully opaque, which would hide the globe canvas sitting at z-index 0 —
 * fading just the background layers lets the wireframe sphere and airport
 * nodes bleed through while land, water, and labels stay fully readable.
 */
const MAP_BACKGROUND_OPACITY = 0.55;

// The airport set loads in parallel with the map style; whichever lands
// second adds the layers.
let airportData: ReadonlyArray<Airport> | null = null;
let mapStyleLoaded = false;

function tryAddAirportLayers(): void {
  if (mapStyleLoaded && airportData && !map.getSource("airports")) {
    addAirportLayers(airportData);
  }
}

void loadAirports().then((airports) => {
  airportData = airports;
  tryAddAirportLayers();
});

map.on("style.load", () => {
  for (const layer of map.getStyle()?.layers ?? []) {
    if (layer.type === "background") {
      map.setPaintProperty(layer.id, "background-opacity", MAP_BACKGROUND_OPACITY);
    }
  }
  mapStyleLoaded = true;
  tryAddAirportLayers();
});

// Plane polygons are sized in geographic units — rebuild while zooming so
// the glyphs hold a constant on-screen size.
map.on("zoom", () => redraw());

// Ambient Three.js globe behind the map (z-stack 0 < 1 < 2).
const globeCanvas = document.getElementById("globe");
const stopGlobe =
  globeCanvas instanceof HTMLCanvasElement ? initGlobe(globeCanvas) : () => {};

const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
map.addControl(overlay);

if (import.meta.env.DEV) {
  const w = window as unknown as Record<string, unknown>;
  w.__overlay = overlay;
  w.__map = map;
}

/**
 * Pushes a freshly built layer stack into the Deck.gl overlay.
 */
function redraw(): void {
  overlay.setProps({ layers: buildLayers() });
}

// Aircraft visibility toggle (bottom-right control).
const planesToggle = document.getElementById("toggle-planes");
planesToggle?.addEventListener("click", () => {
  showPlanes = !showPlanes;
  planesToggle.classList.toggle("map-toggle--active", showPlanes);
  planesToggle.setAttribute("aria-pressed", String(showPlanes));
  if (!showPlanes) setTooltip(null);
  redraw();
});

// Clicking empty map space clears the selection.
map.on("click", (e) => {
  const picked = overlay.pickObject({ x: e.point.x, y: e.point.y, radius: 6 });
  if (!picked) clearSelection();
});

const stopPolling = startPolling({
  onData: (next) => {
    flights = next;
    lastUpdateAt = Date.now();
    consecutiveFeedErrors = 0;
    recordTracks(flights);
    if (!firstDataArrived) {
      firstDataArrived = true;
      dismissSkeleton();
    }
    // Keep the open panel in sync with the selected aircraft.
    if (selectedIcao) {
      const selected = flights.find((f) => f.icao24 === selectedIcao);
      if (selected) showFlight(selected);
    }
    redraw();
    refreshDashboard();
  },
  onError: (err) => {
    // Toast only on the first failure of an outage — subsequent cycles
    // keep retrying silently while the STALE chip carries the status.
    consecutiveFeedErrors += 1;
    if (consecutiveFeedErrors === 1) {
      showToast(`Flight feed error: ${err.message}`);
    }
    if (!firstDataArrived) dismissSkeleton();
    redraw(); // dims glyphs once data crosses the stale threshold
    refreshDashboard();
  },
});

// Re-evaluate staleness even between polls.
window.setInterval(() => {
  redraw();
  refreshDashboard();
}, STALE_AFTER_MS / 2);

window.addEventListener("beforeunload", () => {
  stopPolling();
  stopGlobe();
});
