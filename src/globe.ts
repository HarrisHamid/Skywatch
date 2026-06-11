/**
 * globe.ts — Phase 2 ambient backdrop: a Three.js wireframe globe with
 * glowing airport nodes, rendered to a dedicated canvas that sits *behind*
 * the Deck.gl map in the z-stack (globe z:0, map z:1, panel z:2).
 *
 * Decorative only: no orbit controls, no picking — a constant slow spin
 * of 0.05° per frame.
 */

import * as THREE from "three";

/** Spin rate in degrees per rendered frame. */
const SPIN_DEG_PER_FRAME = 0.05;

/** Globe radius in scene units. */
const GLOBE_RADIUS = 2.2;

/** Token colors mirrored from styles.css (Three.js needs numeric colors). */
const CYAN = 0x00f0dc;

/**
 * Major airports plotted as glowing nodes: [name, latitude, longitude].
 * A small, recognizable set — enough to read as a global network without
 * turning the backdrop into noise.
 */
const AIRPORTS: ReadonlyArray<readonly [string, number, number]> = [
  ["ATL", 33.6407, -84.4277],
  ["LAX", 33.9416, -118.4085],
  ["ORD", 41.9742, -87.9073],
  ["DFW", 32.8998, -97.0403],
  ["JFK", 40.6413, -73.7781],
  ["DEN", 39.8561, -104.6737],
  ["SFO", 37.6213, -122.379],
  ["SEA", 47.4502, -122.3088],
  ["MIA", 25.7959, -80.287],
  ["YYZ", 43.6777, -79.6248],
  ["LHR", 51.47, -0.4543],
  ["CDG", 49.0097, 2.5479],
  ["FRA", 50.0379, 8.5622],
  ["DXB", 25.2532, 55.3657],
  ["HND", 35.5494, 139.7798],
  ["SIN", 1.3644, 103.9915],
  ["SYD", -33.9399, 151.1753],
  ["GRU", -23.4356, -46.4731],
  ["JNB", -26.1367, 28.2411],
  ["DEL", 28.5562, 77.1],
];

/**
 * Converts geographic coordinates to a position on the globe surface.
 * Uses the standard spherical mapping with +Z toward (lat 0, lon 0).
 *
 * @param latitude - Degrees north.
 * @param longitude - Degrees east.
 * @param radius - Sphere radius in scene units.
 * @returns Cartesian position on the sphere.
 */
export function latLonToVector3(
  latitude: number,
  longitude: number,
  radius: number
): THREE.Vector3 {
  const phi = THREE.MathUtils.degToRad(90 - latitude);
  const theta = THREE.MathUtils.degToRad(longitude + 90);
  return new THREE.Vector3(
    radius * Math.sin(phi) * Math.sin(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.cos(theta)
  );
}

/**
 * Paints a soft radial-gradient dot onto an offscreen canvas, used as the
 * sprite texture for the glowing airport points (additive blending makes
 * overlapping nodes bloom slightly).
 *
 * @returns A texture suitable for `THREE.PointsMaterial.map`.
 */
function createGlowTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const gradient = ctx.createRadialGradient(
      size / 2, size / 2, 0,
      size / 2, size / 2, size / 2
    );
    gradient.addColorStop(0, "rgba(0, 240, 220, 1)");
    gradient.addColorStop(0.35, "rgba(0, 240, 220, 0.55)");
    gradient.addColorStop(1, "rgba(0, 240, 220, 0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Boots the ambient globe inside the given canvas: builds the wireframe
 * sphere and airport node cloud, starts the spin loop, and wires up
 * resize handling. Honors `prefers-reduced-motion` by freezing the spin
 * while still rendering a static frame.
 *
 * @param canvas - The dedicated `<canvas>` element at z-index 0.
 * @returns A cleanup function that stops the loop and frees GPU resources.
 */
export function initGlobe(canvas: HTMLCanvasElement): () => void {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    38,
    window.innerWidth / window.innerHeight,
    0.1,
    100
  );
  camera.position.set(0, 0.6, 7);
  camera.lookAt(0, 0, 0);

  const globe = new THREE.Group();
  scene.add(globe);

  // Subtle wireframe shell.
  const sphereGeometry = new THREE.SphereGeometry(GLOBE_RADIUS, 36, 24);
  const wireMaterial = new THREE.MeshBasicMaterial({
    color: CYAN,
    wireframe: true,
    transparent: true,
    opacity: 0.07,
  });
  globe.add(new THREE.Mesh(sphereGeometry, wireMaterial));

  // Glowing airport nodes.
  const positions = new Float32Array(AIRPORTS.length * 3);
  AIRPORTS.forEach(([, lat, lon], i) => {
    const v = latLonToVector3(lat, lon, GLOBE_RADIUS * 1.005);
    positions[i * 3] = v.x;
    positions[i * 3 + 1] = v.y;
    positions[i * 3 + 2] = v.z;
  });
  const nodeGeometry = new THREE.BufferGeometry();
  nodeGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const nodeMaterial = new THREE.PointsMaterial({
    size: 0.09,
    map: createGlowTexture(),
    color: CYAN,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  globe.add(new THREE.Points(nodeGeometry, nodeMaterial));

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const spinRad = THREE.MathUtils.degToRad(SPIN_DEG_PER_FRAME);

  let frameId = 0;
  const animate = (): void => {
    if (!reducedMotion.matches) {
      globe.rotation.y += spinRad;
    }
    renderer.render(scene, camera);
    frameId = window.requestAnimationFrame(animate);
  };
  frameId = window.requestAnimationFrame(animate);

  const handleResize = (): void => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  };
  window.addEventListener("resize", handleResize);

  return () => {
    window.cancelAnimationFrame(frameId);
    window.removeEventListener("resize", handleResize);
    sphereGeometry.dispose();
    wireMaterial.dispose();
    nodeGeometry.dispose();
    nodeMaterial.map?.dispose();
    nodeMaterial.dispose();
    renderer.dispose();
  };
}
