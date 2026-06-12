# SKYWATCH — Phase 1

Live flight tracker. Deck.gl (MapboxOverlay) over a dark Mapbox base style,
fed by the OpenSky Network through a local Express proxy. Vanilla TypeScript,
no framework.

## Setup

```bash
npm install
cp .env.example .env   # then paste your Mapbox token
npm run dev            # starts the proxy (:3001) and Vite (:5173) together
```

Open http://localhost:5173.

### Mapbox token

The dark base style (`mapbox://styles/mapbox/dark-v11`) requires a free
Mapbox access token: https://account.mapbox.com/access-tokens/

Put it in `.env`:

```
VITE_MAPBOX_TOKEN=pk.your_token_here
```

## Architecture

```
browser ──/api/flights?bbox=…──▶ Express proxy (:3001) ──▶ OpenSky states/all
   ▲                                   │ 10 s response cache
   └── Deck.gl ScatterplotLayer + IconLayer, repainted every 12 s poll
```

- `src/flights.ts` — `FlightState` type, raw state-vector parsing, 12 s poller
- `src/panel.ts` — telemetry side panel + route-completion estimate
- `src/main.ts` — Mapbox map, Deck.gl overlay, layers, skeleton, toast
- `server/proxy.ts` — bbox validation, OpenSky forwarding, short cache

## Behavior notes

- **Globe backdrop (Phase 2):** `src/globe.ts` renders a Three.js wireframe
  sphere with glowing nodes at 20 major airports, spinning at 0.05°/frame.
  Z-stack: globe canvas `0` → Deck.gl map `1` → telemetry panel `2`. Because
  Mapbox dark-v11 ships fully opaque, `main.ts` fades the style's background
  layers to 0.55 opacity on load so the globe bleeds through; land, water,
  and labels stay untouched. The spin freezes under `prefers-reduced-motion`.
- **Smooth motion:** between polls, `src/motion.ts` dead-reckons each
  aircraft along its reported track at its reported ground speed, and a
  ~30 fps render loop repaints so planes glide instead of teleporting.
  Corrections from each new fix ease in over ~1 s rather than snapping.
  Extrapolation caps at 30 s past the last fix, and the loop is skipped
  under `prefers-reduced-motion` (polls then repaint exact positions).
- **Stale data:** if no successful fetch lands within 30 s, glyphs repaint
  amber (`--accent-amber`) until the feed recovers.
- **Route completion:** Phase 1 estimates from altitude alone (capped at 50%,
  since altitude can't distinguish climb from descent). Phase 2 will use
  vertical rate to resolve the full profile.
- **OpenSky rate limits:** anonymous access allows limited daily credits.
  The proxy's 10 s cache keeps multiple tabs from multiplying upstream calls.

## Future ideas

Flight trails, vertical-rate-aware progress, search/filter, and clustering.
# Skywatch
