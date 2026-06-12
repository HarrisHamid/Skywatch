/**
 * heroGlobe.ts — Landing-page centerpiece: a wireframe dotted Earth
 * (ported from 21st.dev's "wireframe-dotted-globe" React component to
 * vanilla TypeScript — same d3-geo rendering, no React required).
 *
 * Real Natural Earth coastlines drawn as white outlines over a graticule
 * mesh, with halftone dots filling the landmasses. Auto-rotates; drag to
 * rotate, scroll to zoom. Honors prefers-reduced-motion.
 */

import { geoOrthographic, geoPath, geoGraticule, geoBounds, geoDistance } from "d3-geo";
import { timer, type Timer } from "d3-timer";
import type { Feature, FeatureCollection, Polygon, MultiPolygon } from "geojson";

/** Natural Earth 110m land polygons (GeoJSON). */
const LAND_URL =
  "https://raw.githubusercontent.com/martynafford/natural-earth-geojson/refs/heads/master/110m/physical/ne_110m_land.json";

/** Degrees of rotation per animation tick. */
const ROTATION_SPEED = 0.2;

/** Grid step (degrees) for the halftone land dots. */
const DOT_STEP_DEG = 16 * 0.08;

type LandFeature = Feature<Polygon | MultiPolygon>;

interface Dot {
  lng: number;
  lat: number;
}

/**
 * Ray-casting point-in-ring test.
 *
 * @param point - `[lng, lat]` to test.
 * @param ring - Polygon ring coordinates.
 * @returns True when the point lies inside the ring.
 */
function pointInRing(point: [number, number], ring: number[][]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Tests whether a point lies on land within a (Multi)Polygon feature,
 * honoring holes.
 *
 * @param point - `[lng, lat]` to test.
 * @param feature - Land polygon feature.
 * @returns True when the point is inside the feature.
 */
function pointInFeature(point: [number, number], feature: LandFeature): boolean {
  const geometry = feature.geometry;
  const polygons =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;

  for (const polygon of polygons) {
    if (!pointInRing(point, polygon[0] as number[][])) continue;
    let inHole = false;
    for (let i = 1; i < polygon.length; i++) {
      if (pointInRing(point, polygon[i] as number[][])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

/**
 * Generates the halftone dot grid covering one land feature.
 *
 * @param feature - Land polygon feature.
 * @returns Dots inside the feature.
 */
function generateDots(feature: LandFeature): Dot[] {
  const dots: Dot[] = [];
  const [[minLng, minLat], [maxLng, maxLat]] = geoBounds(feature);
  for (let lng = minLng; lng <= maxLng; lng += DOT_STEP_DEG) {
    for (let lat = minLat; lat <= maxLat; lat += DOT_STEP_DEG) {
      if (pointInFeature([lng, lat], feature)) dots.push({ lng, lat });
    }
  }
  return dots;
}

/**
 * Boots the wireframe dotted globe inside the given full-viewport canvas.
 *
 * @param canvas - Canvas element behind the landing content.
 * @returns Cleanup function that stops the loop and detaches listeners.
 */
export function initHeroGlobe(canvas: HTMLCanvasElement): () => void {
  const context = canvas.getContext("2d");
  if (!context) return () => {};

  let width = 0;
  let height = 0;
  let baseRadius = 0;
  let centerX = 0;
  let centerY = 0;

  const projection = geoOrthographic().clipAngle(90);
  const path = geoPath(projection, context);
  const graticule = geoGraticule();

  // d3 rotate([λ, φ]) centers the point at (-λ, -φ): this faces the U.S.
  const rotation: [number, number] = [98, -32];
  let landFeatures: FeatureCollection | null = null;
  const allDots: Dot[] = [];

  /**
   * Recomputes layout: the globe sits right of the copy on wide screens
   * and recenters below it on narrow ones.
   */
  const layout = (): void => {
    width = window.innerWidth;
    height = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    const wide = width > 980;
    baseRadius = Math.min(width, height) / (wide ? 2.5 : 3.2);
    centerX = wide ? width * 0.7 : width / 2;
    centerY = wide ? height * 0.52 : height * 0.62;
    projection.scale(baseRadius).translate([centerX, centerY]);
  };
  layout();

  const render = (): void => {
    context.clearRect(0, 0, width, height);
    projection.rotate([rotation[0], rotation[1]]);

    const currentScale = projection.scale();
    const scaleFactor = currentScale / baseRadius;

    // Ocean disc.
    context.beginPath();
    context.arc(centerX, centerY, currentScale, 0, 2 * Math.PI);
    context.fillStyle = "#000000";
    context.fill();
    context.strokeStyle = "#ffffff";
    context.lineWidth = 2 * scaleFactor;
    context.stroke();

    // Graticule mesh.
    context.beginPath();
    path(graticule());
    context.strokeStyle = "#ffffff";
    context.lineWidth = 1 * scaleFactor;
    context.globalAlpha = 0.25;
    context.stroke();
    context.globalAlpha = 1;

    if (landFeatures) {
      // Land outlines.
      context.beginPath();
      for (const feature of landFeatures.features) {
        path(feature);
      }
      context.strokeStyle = "#ffffff";
      context.lineWidth = 1 * scaleFactor;
      context.stroke();

      // Halftone dots — only those on the visible hemisphere.
      const viewCenter: [number, number] = [-rotation[0], -rotation[1]];
      context.fillStyle = "#999999";
      for (const dot of allDots) {
        if (geoDistance([dot.lng, dot.lat], viewCenter) > Math.PI / 2) continue;
        const projected = projection([dot.lng, dot.lat]);
        if (!projected) continue;
        context.beginPath();
        context.arc(projected[0], projected[1], 1.2 * scaleFactor, 0, 2 * Math.PI);
        context.fill();
      }
    }
  };

  // Load coastline data, then build the dot grid.
  void (async () => {
    try {
      const response = await fetch(LAND_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      landFeatures = (await response.json()) as FeatureCollection;
      for (const feature of landFeatures.features) {
        allDots.push(...generateDots(feature as LandFeature));
      }
      render();
    } catch {
      // Coastlines unavailable — the graticule sphere still renders.
      render();
    }
  })();

  // Auto-rotation (paused while dragging; disabled for reduced motion).
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let autoRotate = !reducedMotion.matches;

  const rotationTimer: Timer = timer(() => {
    if (autoRotate) {
      rotation[0] += ROTATION_SPEED;
      render();
    }
  });

  // Drag to rotate.
  const handleMouseDown = (event: MouseEvent): void => {
    autoRotate = false;
    canvas.style.cursor = "grabbing";
    const startX = event.clientX;
    const startY = event.clientY;
    const startRotation: [number, number] = [rotation[0], rotation[1]];

    const handleMouseMove = (moveEvent: MouseEvent): void => {
      const sensitivity = 0.5;
      rotation[0] = startRotation[0] + (moveEvent.clientX - startX) * sensitivity;
      rotation[1] = Math.max(
        -90,
        Math.min(90, startRotation[1] - (moveEvent.clientY - startY) * sensitivity)
      );
      render();
    };

    const handleMouseUp = (): void => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      canvas.style.cursor = "grab";
      if (!reducedMotion.matches) {
        window.setTimeout(() => {
          autoRotate = true;
        }, 10);
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  // Scroll to zoom.
  const handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const factor = event.deltaY > 0 ? 0.9 : 1.1;
    const next = Math.max(
      baseRadius * 0.5,
      Math.min(baseRadius * 3, projection.scale() * factor)
    );
    projection.scale(next);
    render();
  };

  const handleResize = (): void => {
    layout();
    render();
  };

  canvas.addEventListener("mousedown", handleMouseDown);
  canvas.addEventListener("wheel", handleWheel, { passive: false });
  window.addEventListener("resize", handleResize);

  return () => {
    rotationTimer.stop();
    canvas.removeEventListener("mousedown", handleMouseDown);
    canvas.removeEventListener("wheel", handleWheel);
    window.removeEventListener("resize", handleResize);
  };
}
