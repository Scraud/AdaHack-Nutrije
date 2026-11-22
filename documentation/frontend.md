# Frontend

The frontend is an Angular 19 single-page application. It is a dispatcher dashboard: a map, a timeline, an incident form, and a recommendations panel. It does no business logic — all intelligence lives in the backend.

---

## Tech Stack

| Technology | Version | Purpose |
|---|---|---|
| **Angular** | 19 | Application framework, components, signals |
| **React** | 18 | Embedded components for map and timeline (via `@angular/elements` host) |
| **Leaflet** | 1.x | Interactive map rendering |
| **TypeScript** | 5.x | Type safety throughout |
| **nginx** | — | Static file server + reverse proxy in production |

The unusual Angular + React combination exists because the map (`dispatch-map.tsx`) and timeline (`vehicle-timeline.tsx`) were built as React components and are embedded into the Angular application via a custom `ReactViewHost` component that uses `createRoot`.

---

## Monorepo Structure

```
frontend/
├── apps/dispatcher/          Angular application
│   └── src/app/
│       ├── core/
│       │   ├── dispatch-store.ts     Global state store (Angular signals)
│       │   └── labels.ts             i18n label maps
│       ├── dashboard/
│       │   ├── dispatcher.ts         Root component
│       │   └── dispatcher.html       Main layout template
│       ├── incidents/
│       │   ├── incident-center.ts    Incident form + demo controls
│       │   └── incident-center.html
│       ├── recommendations/
│       │   ├── recommendation-comparison.ts  Accept/reject panel
│       │   └── recommendation-comparison.html
│       ├── history/
│       │   └── plan-history.ts       Past plan versions list
│       └── react-host/
│           └── react-view-host.ts    Bridge that renders React inside Angular
└── packages/
    ├── contracts/
    │   ├── api.ts            Auto-generated TypeScript types from OpenAPI schema
    │   └── index.ts          Exports + `clock()` utility function
    └── react-views/
        ├── dispatch-map.tsx  Leaflet map (roads, routes, vehicle icons)
        ├── route-motion.ts   Route geometry helpers for smooth vehicle motion
        └── vehicle-timeline.tsx  Gantt-style schedule timeline
```

---

## State Management — `dispatch-store.ts`

`DispatchStore` is an Angular injectable service using **signals** (Angular 19's reactivity primitive). All UI state lives here.

### Key signals

| Signal | Type | Description |
|---|---|---|
| `state` | `State \| null` | Full scenario state from `/api/state` |
| `tracking` | `TrackingFrame \| null` | Vehicle positions from `/api/tracking` |
| `roads` | `RoadMap \| null` | Road geometry from `/api/map/roads` |
| `recommendations` | `Recommendation[]` | Current open recommendations |
| `history` | `PlanSummary[]` | Plan version history |
| `preview` | `Plan \| null` | Plan being previewed (before accepting) |
| `busy` | `string` | Label of in-flight operation (disables UI) |
| `error` | `string` | Last error message |
| `notification` | `string` | Last success message |
| `roadTarget` | `RoadSegment \| null` | Road selected for a new delay/closure (by street name or map click) |
| `picking` | `boolean` | Map click selects a road (`pickAt` → `/api/map/roads/nearest`) |

Road event helpers: `findStreet(name)` (`/api/map/roads/street`), `pickAt(lat, lon)` and `resolveIncident(id)` (`POST /api/incidents/{id}/resolve`).

### Polling

On `initialize()` (called by the root `Dispatcher` component on startup):
- Loads state, roads, conditions.
- Starts a `setInterval` that calls `refreshTracking()` every 1 second.

`refreshTracking()` fetches `/api/tracking`. If the returned `revision` has changed, it also re-fetches `/api/state` and refreshes the recommendations/plan history lists.

### Mutations

All state-changing actions go through `run(label, action)`, which sets `busy`, clears errors, runs the async action, and clears `busy` on completion. If an error occurs, it syncs state from the server to recover.

`changeState(path, label, body)` is the common pattern for incident/reset/advance-time calls: POSTs to the API, sets the returned state, refreshes lists, and refreshes tracking.

---

## Root Component — `Dispatcher`

`dispatcher.html` is the top-level layout. It composes:
- `ReactViewHost` → renders the Leaflet map and vehicle timeline
- `IncidentCenter` → incident injection and demo controls
- `RecommendationComparison` → preview and accept/reject panel
- `PlanHistory` → list of past plan versions

The `Dispatcher` component also owns the task table: a list of all tasks with their assignment status, colour-coded by priority and risk.

---

## Map — `dispatch-map.tsx` (React + Leaflet)

A React component that creates a Leaflet map instance and maintains it via refs and effects.

### Layers (z-ordered)

| Pane | z-index | Contents |
|---|---|---|
| `road-base` | 300 | Road polylines from `/api/map/roads`, styled by rank |
| `vehicle-paths` | 390 | Vehicle route lines (solid = to pickup, dashed = to hospital) |
| `road-events` | 410 | Active road closures / delays and the selected road preview |
| Leaflet default | 400 | Site markers (facility pins, event location pins), vehicle icons |

### Rendering logic

1. **Road basemap** — rendered once from the `RoadMap` received via props. Each rank gets a different stroke width and opacity.

2. **Vehicle routes** — re-rendered when `tracking.vehicles` changes. For each vehicle, two polylines: `to_pickup` (solid) and `to_hospital` (dashed). Opacity is reduced for `STOPPED` vehicles. The already-driven part of the line is removed continuously.

3. **Vehicle markers** — emoji pins (`🚑`) with ETA, animated smoothly along the route between tracking frames (`requestAnimationFrame` + `route-motion.ts`). Colour is assigned per vehicle id from a fixed palette. Tooltip shows vehicle id and status.

4. **Site markers** — facility pins (`🏥`) and pickup pins. A pickup pin is hidden once the patient has been picked up.

5. **Road event overlays** — polylines from `RoadEvent.paths` for active closures or delays, plus a preview of the road selected in the incident panel. With `picking` enabled, a map click calls `onPick(lat, lon)`.

6. **Selected task highlight** — when a task is selected in the task list, the map pans/zooms to its pickup location and highlights the assigned vehicle's route.

### React in Angular bridge — `react-view-host.ts`

`ReactViewHost` is an Angular component that calls `createRoot(nativeElement).render(<DispatchMap .../>)` and passes Angular signal values as React props. It updates React when the Angular signals change by calling `root.render()` again.

---

## Timeline — `vehicle-timeline.tsx` (React)

A Gantt-style horizontal bar chart showing all vehicle schedules.

- One row per vehicle.
- Each assignment is a `<button>` bar whose left position and width are proportional to `(planned_departure / horizon)` and `(planned_end − planned_departure) / horizon`.
- Each bar is subdivided into coloured segments: driving-to-pickup (blue), waiting/service (grey), driving-to-hospital (blue), dropoff/cleaning (grey).
- Clicking a bar calls `onSelect(task_id)` which scrolls to and highlights that task in the task table.
- A vertical "now" line at `state.now / horizon * 100%` shows the current simulated time.
- Tasks with `risk.has(task_id)` get a red border (at-risk indicator).

---

## TypeScript API Contracts — `packages/contracts/api.ts`

Generated automatically from the FastAPI OpenAPI spec using `openapi-typescript`. **Do not edit manually.** To regenerate:

```sh
cd backend
python export_openapi.py > ../frontend/packages/contracts/openapi.json
cd ../frontend
npx openapi-typescript packages/contracts/openapi.json -o packages/contracts/api.ts
```

The `index.ts` re-exports all types and adds the `clock(start_at, seconds)` utility that converts a seconds-since-start integer to a `HH:MM` string in the Europe/Ljubljana timezone.

---

## Production Build

The `frontend/Dockerfile` builds the Angular app with `ng build` and copies the output into an nginx container. `nginx.conf` serves static files and proxies `/api/*` to `http://backend:8000`.
