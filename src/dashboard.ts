/**
 * dashboard.ts — Left-hand ops dashboard: live fleet statistics, feed
 * status, a search box, and a scrollable contact list. Clicking a row
 * selects that aircraft on the map.
 */

import type { FlightState } from "./flights";
import { altitudeColor, formatFeet, formatKnots, M_TO_FT, MS_TO_KT } from "./altitude";

/** Rows added to the contact list per "show more" click. */
const PAGE_SIZE = 100;

/** Callbacks the dashboard reports back through. */
export interface DashboardCallbacks {
  /** Invoked when the user clicks a contact row. */
  onSelect: (flight: FlightState) => void;
}

let rootEl: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let callbacks: DashboardCallbacks | null = null;

let searchQuery = "";
let visibleCount = PAGE_SIZE;
let lastFlights: ReadonlyArray<FlightState> = [];
let lastSelected: string | null = null;

/**
 * Escapes text destined for innerHTML (callsigns come from the wire).
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Builds the dashboard DOM, mounts it, and wires up search, row
 * selection, and the collapse toggle.
 *
 * @param container - Element the dashboard is appended to (usually `#app`).
 * @param cb - Selection callback bundle.
 */
export function initDashboard(container: HTMLElement, cb: DashboardCallbacks): void {
  callbacks = cb;

  const dash = document.createElement("aside");
  dash.id = "dashboard";
  dash.className = "dash";
  dash.innerHTML = `
    <header class="dash__brand">
      <div>
        <h1>Skywatch</h1>
        <p>Live ADS-B · CONUS sector</p>
      </div>
      <div class="dash__status" data-field="statusChip">
        <span class="dash__status-dot"></span>
        <span data-field="statusText">SYNC</span>
      </div>
    </header>

    <dl class="dash__stats">
      <div class="dash__stat"><dt>CONTACTS</dt><dd data-field="contacts">—</dd></div>
      <div class="dash__stat"><dt>AIRBORNE</dt><dd data-field="airborne">—</dd></div>
      <div class="dash__stat"><dt>AVG ALT</dt><dd><span data-field="avgAlt">—</span><small> FT</small></dd></div>
      <div class="dash__stat"><dt>MAX GS</dt><dd><span data-field="maxGs">—</span><small> KT</small></dd></div>
    </dl>

    <div class="dash__search">
      <input
        type="search"
        placeholder="SEARCH CALLSIGN / HEX / COUNTRY"
        aria-label="Search flights"
        autocomplete="off"
        spellcheck="false"
      />
    </div>

    <div class="dash__list-head">
      <span>CALLSIGN</span><span>ALT FT</span><span>GS KT</span><span>HDG</span>
    </div>
    <ul class="dash__list" data-field="list"></ul>
    <div class="dash__footer">
      <p class="dash__count" data-field="count">—</p>
      <button class="dash__more" data-field="more" type="button" hidden>
        ▾ SHOW ${PAGE_SIZE} MORE
      </button>
    </div>

    <button class="dash__toggle" type="button" aria-label="Toggle dashboard">◀</button>
  `;

  const input = dash.querySelector<HTMLInputElement>("input[type=search]");
  input?.addEventListener("input", () => {
    searchQuery = input.value.trim().toLowerCase();
    visibleCount = PAGE_SIZE;
    renderList();
  });

  dash
    .querySelector<HTMLButtonElement>('[data-field="more"]')
    ?.addEventListener("click", () => {
      visibleCount += PAGE_SIZE;
      renderList();
    });

  listEl = dash.querySelector<HTMLElement>('[data-field="list"]');
  listEl?.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-icao]");
    if (!row) return;
    const flight = lastFlights.find((f) => f.icao24 === row.dataset.icao);
    if (flight) callbacks?.onSelect(flight);
  });

  const toggle = dash.querySelector<HTMLButtonElement>(".dash__toggle");
  toggle?.addEventListener("click", () => {
    const collapsed = dash.classList.toggle("dash--collapsed");
    toggle.textContent = collapsed ? "▶" : "◀";
  });

  container.appendChild(dash);
  rootEl = dash;
}

/**
 * Refreshes stats, status chip, and the contact list with a new fleet
 * snapshot. Call on every poll cycle and whenever the selection changes.
 *
 * @param flights - Current flight set.
 * @param selectedIcao - Currently selected aircraft, if any.
 * @param stale - Whether the feed has crossed the staleness threshold.
 */
export function updateDashboard(
  flights: ReadonlyArray<FlightState>,
  selectedIcao: string | null,
  stale: boolean
): void {
  if (!rootEl) return;
  lastFlights = flights;
  lastSelected = selectedIcao;

  const set = (field: string, value: string): void => {
    const el = rootEl?.querySelector<HTMLElement>(`[data-field="${field}"]`);
    if (el) el.textContent = value;
  };

  const airborne = flights.filter((f) => !f.onGround);
  const avgAltM = airborne.length
    ? airborne.reduce((sum, f) => sum + f.altitude, 0) / airborne.length
    : 0;
  const fastest = flights.reduce<FlightState | null>(
    (best, f) => (!best || f.velocity > best.velocity ? f : best),
    null
  );

  set("contacts", flights.length.toLocaleString("en-US"));
  set("airborne", airborne.length.toLocaleString("en-US"));
  set("avgAlt", Math.round(avgAltM * M_TO_FT).toLocaleString("en-US"));
  set("maxGs", fastest ? String(Math.round(fastest.velocity * MS_TO_KT)) : "—");

  const chip = rootEl.querySelector<HTMLElement>('[data-field="statusChip"]');
  chip?.classList.toggle("dash__status--stale", stale);
  set("statusText", stale ? "STALE" : "LIVE");

  renderList();
}

/**
 * Renders the (filtered, capped) contact list from the latest snapshot.
 */
function renderList(): void {
  if (!rootEl || !listEl) return;

  const q = searchQuery;
  const filtered = q
    ? lastFlights.filter(
        (f) =>
          f.callsign.toLowerCase().includes(q) ||
          f.icao24.toLowerCase().includes(q) ||
          f.originCountry.toLowerCase().includes(q)
      )
    : lastFlights;

  const sorted = [...filtered].sort((a, b) =>
    (a.callsign || a.icao24).localeCompare(b.callsign || b.icao24)
  );
  const visible = sorted.slice(0, visibleCount);

  listEl.innerHTML = visible
    .map((f) => {
      const [r, g, b] = altitudeColor(f.altitude, f.onGround);
      const selected = f.icao24 === lastSelected ? " dash__row--selected" : "";
      const callsign = escapeHtml(f.callsign || f.icao24.toUpperCase());
      return `
        <li class="dash__row${selected}" data-icao="${escapeHtml(f.icao24)}" role="button" tabindex="0">
          <span class="dash__row-cs">
            <b>${callsign}</b>
            <small>${escapeHtml(f.originCountry)}</small>
          </span>
          <span style="color: rgb(${r},${g},${b})">${f.onGround ? "GND" : formatFeet(f.altitude)}</span>
          <span>${formatKnots(f.velocity)}</span>
          <span class="dash__row-hdg" style="transform: rotate(${Math.round(f.heading)}deg)">↑</span>
        </li>`;
    })
    .join("");

  const countEl = rootEl.querySelector<HTMLElement>('[data-field="count"]');
  if (countEl) {
    countEl.textContent =
      filtered.length > visible.length
        ? `SHOWING ${visible.length} OF ${filtered.length.toLocaleString("en-US")} CONTACTS`
        : `${filtered.length.toLocaleString("en-US")} CONTACTS`;
  }

  const moreBtn = rootEl.querySelector<HTMLButtonElement>('[data-field="more"]');
  if (moreBtn) moreBtn.hidden = filtered.length <= visible.length;
}
