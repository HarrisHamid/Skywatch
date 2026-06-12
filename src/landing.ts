/**
 * landing.ts — Landing page bootstrap: hero globe + live aircraft count.
 */

import { initHeroGlobe } from "./heroGlobe";
import { BBOX } from "./flights";
import "./landing.css";

const canvas = document.getElementById("hero-globe");
if (canvas instanceof HTMLCanvasElement) {
  initHeroGlobe(canvas);
}

/**
 * Animates the live-count stat from 0 to the target over ~1.2 s.
 *
 * @param el - The stat element.
 * @param target - Final count.
 */
function countUp(el: HTMLElement, target: number): void {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (reducedMotion.matches) {
    el.textContent = target.toLocaleString("en-US");
    return;
  }
  const start = performance.now();
  const duration = 1200;
  const tick = (now: number): void => {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = Math.round(target * eased).toLocaleString("en-US");
    if (t < 1) window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
}

/**
 * Fetches the live aircraft count for the stats strip. Also warms the
 * server's tile mosaic, so the tracker opens with data already hot.
 */
async function loadLiveCount(): Promise<void> {
  const el = document.getElementById("stat-live");
  if (!el) return;
  try {
    const response = await fetch(`/api/flights?bbox=${BBOX}`);
    if (!response.ok) throw new Error(String(response.status));
    const body = (await response.json()) as { states?: unknown[] | null };
    const count = body.states?.length ?? 0;
    if (count > 0) countUp(el, count);
    else el.textContent = "LIVE";
  } catch {
    el.textContent = "LIVE";
  }
}

void loadLiveCount();
