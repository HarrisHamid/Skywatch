/**
 * panel.ts — Telemetry side panel: render, update, and route-completion
 * estimation for the currently selected flight.
 */

import type { FlightState } from "./flights";
import type { FlightRoute } from "./enrichment";
import { formatFeet, formatKnots, MS_TO_FPM } from "./altitude";

/** Typical jet cruise altitude (m) used by the route-completion heuristic. */
const CRUISE_ALTITUDE_M = 11_000;

/** Vertical rates within ±this (m/s) count as level flight. */
const LEVEL_FLIGHT_BAND_MS = 1.5;

let panelEl: HTMLElement | null = null;
let onCloseCallback: (() => void) | null = null;

/**
 * Estimates route completion (0–1) from the altitude profile and vertical
 * rate.
 *
 * Heuristic: ground reads 0%. A climbing aircraft maps to the first third
 * of the route (5–35%), level flight to the middle (35–65%), and a
 * descending aircraft to the final third (65–95%) — the altitude within
 * each phase positions the estimate inside that band.
 *
 * @param altitude - Barometric altitude in meters.
 * @param onGround - Whether the aircraft is reported on the ground.
 * @param verticalRate - Vertical rate in m/s (positive = climbing).
 * @returns Estimated completion fraction in the range [0, 1].
 */
export function estimateRouteCompletion(
  altitude: number,
  onGround: boolean,
  verticalRate = 0
): number {
  if (onGround) return 0;
  const normalized = Math.min(Math.max(altitude / CRUISE_ALTITUDE_M, 0), 1);
  if (verticalRate > LEVEL_FLIGHT_BAND_MS) return 0.05 + normalized * 0.3;
  if (verticalRate < -LEVEL_FLIGHT_BAND_MS) return 0.95 - normalized * 0.3;
  return 0.35 + normalized * 0.3;
}

/**
 * Builds the panel's static DOM skeleton and attaches it to the container.
 * The panel starts hidden; call {@link showFlight} to populate and reveal it.
 *
 * @param container - Element the panel is appended to (usually `#app`).
 * @param onClose - Invoked when the user dismisses the panel.
 */
export function initPanel(container: HTMLElement, onClose: () => void): void {
  onCloseCallback = onClose;

  const panel = document.createElement("aside");
  panel.id = "telemetry-panel";
  panel.className = "panel";
  panel.setAttribute("aria-hidden", "true");
  panel.innerHTML = `
    <header class="panel__header">
      <div>
        <p class="panel__eyebrow">TARGET LOCK</p>
        <h2 class="panel__callsign" data-field="callsign">—</h2>
        <p class="panel__country" data-field="originCountry">—</p>
      </div>
      <button class="panel__close" type="button" aria-label="Close panel">✕</button>
    </header>

    <dl class="panel__grid">
      <div class="panel__row"><dt>ALT</dt><dd><span data-field="altitude">—</span> ft</dd></div>
      <div class="panel__row"><dt>GS</dt><dd><span data-field="velocity">—</span> kt</dd></div>
      <div class="panel__row"><dt>HDG</dt><dd><span data-field="heading">—</span>°</dd></div>
      <div class="panel__row"><dt>V/S</dt><dd><span data-field="verticalRate">—</span> fpm</dd></div>
      <div class="panel__row"><dt>LAT</dt><dd data-field="latitude">—</dd></div>
      <div class="panel__row"><dt>LON</dt><dd data-field="longitude">—</dd></div>
      <div class="panel__row"><dt>PHASE</dt><dd data-field="phase">—</dd></div>
      <div class="panel__row"><dt>HEX</dt><dd data-field="hex">—</dd></div>
    </dl>

    <section class="panel__route">
      <p class="panel__route-label">ROUTE</p>
      <div class="panel__route-row">
        <div class="panel__route-end">
          <b data-field="routeFromCode">—</b>
          <small data-field="routeFromCity"></small>
        </div>
        <span class="panel__route-arrow">⟶</span>
        <div class="panel__route-end panel__route-end--right">
          <b data-field="routeToCode">—</b>
          <small data-field="routeToCity"></small>
        </div>
      </div>
      <p class="panel__route-note" data-field="routeNote">looking up route…</p>
    </section>

    <section class="panel__progress">
      <p class="panel__progress-label">
        ROUTE COMPLETION <span class="panel__progress-pct" data-field="progressPct">—</span>
      </p>
      <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100">
        <div class="progress-fill" data-field="progressFill"></div>
      </div>
      <p class="panel__progress-note">est. from altitude &amp; vertical rate</p>
    </section>
  `;

  panel.querySelector(".panel__close")?.addEventListener("click", () => {
    hidePanel();
    onCloseCallback?.();
  });

  container.appendChild(panel);
  panelEl = panel;
}

/**
 * Writes a flight's telemetry into the panel and slides it into view.
 * Safe to call repeatedly with fresh data for the same aircraft — fields
 * update in place on each poll cycle.
 *
 * @param flight - The flight currently selected on the map.
 */
export function showFlight(flight: FlightState): void {
  if (!panelEl) return;

  const set = (field: string, value: string): void => {
    const el = panelEl?.querySelector<HTMLElement>(`[data-field="${field}"]`);
    if (el) el.textContent = value;
  };

  const fpm = Math.round(flight.verticalRate * MS_TO_FPM);
  const phase = flight.onGround
    ? "GROUND"
    : fpm > 300
      ? "CLIMB"
      : fpm < -300
        ? "DESCENT"
        : "CRUISE";

  set("callsign", flight.callsign || flight.icao24.toUpperCase());
  set("originCountry", flight.originCountry);
  set("altitude", formatFeet(flight.altitude));
  set("velocity", formatKnots(flight.velocity));
  set("heading", flight.heading.toFixed(0).padStart(3, "0"));
  set("verticalRate", `${fpm > 0 ? "+" : ""}${fpm.toLocaleString("en-US")}`);
  set("latitude", flight.latitude.toFixed(4));
  set("longitude", flight.longitude.toFixed(4));
  set("phase", phase);
  set("hex", flight.icao24.toUpperCase());

  const completion = estimateRouteCompletion(
    flight.altitude,
    flight.onGround,
    flight.verticalRate
  );
  const pct = Math.round(completion * 100);
  set("progressPct", `${pct}%`);

  const fill = panelEl.querySelector<HTMLElement>('[data-field="progressFill"]');
  if (fill) fill.style.width = `${pct}%`;
  const track = panelEl.querySelector<HTMLElement>(".progress-track");
  if (track) track.setAttribute("aria-valuenow", String(pct));

  panelEl.classList.add("panel--open");
  panelEl.setAttribute("aria-hidden", "false");
}

/**
 * Writes the resolved (or unresolved) route into the panel's ROUTE
 * section. Call with `undefined` while a lookup is pending, `null` when
 * the callsign is unknown, or the route once resolved.
 *
 * @param route - The flight's route lookup result.
 */
export function showRoute(route: FlightRoute | null | undefined): void {
  if (!panelEl) return;
  const set = (field: string, value: string): void => {
    const el = panelEl?.querySelector<HTMLElement>(`[data-field="${field}"]`);
    if (el) el.textContent = value;
  };

  if (route === undefined) {
    set("routeFromCode", "—");
    set("routeFromCity", "");
    set("routeToCode", "—");
    set("routeToCity", "");
    set("routeNote", "looking up route…");
    return;
  }
  if (route === null) {
    set("routeFromCode", "—");
    set("routeFromCity", "");
    set("routeToCode", "—");
    set("routeToCity", "");
    set("routeNote", "route not in database");
    return;
  }

  set("routeFromCode", route.origin.code);
  set("routeFromCity", route.origin.municipality || route.origin.name);
  set("routeToCode", route.destination.code);
  set("routeToCity", route.destination.municipality || route.destination.name);
  set("routeNote", `${route.origin.name} → ${route.destination.name}`);
}

/**
 * Slides the panel out of view without destroying its DOM, so the next
 * selection reveals instantly.
 */
export function hidePanel(): void {
  if (!panelEl) return;
  panelEl.classList.remove("panel--open");
  panelEl.setAttribute("aria-hidden", "true");
}
