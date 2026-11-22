# REST API Reference

Base URL: `/api/`

All requests and responses use `Content-Type: application/json`. Times are integers (seconds since scenario start). All endpoints return `application/json` on success or a problem object on error:

```json
{ "detail": { "code": "ERROR_CODE", "message": "Human-readable message" } }
```

---

## Health

### `GET /api/health`
Returns `{ "status": "ok" }`. Used by Docker Compose healthcheck.

---

## Scenario State

### `GET /api/state` → `State`
Full scenario snapshot: vehicles, tasks, facilities, incidents, active plan, baseline metrics.

### `GET /api/metrics` → `Baseline`
Just the `baseline` field of the state (current plan metrics and affected tasks).

---

## Demo Controls

### `POST /api/demo/reset` → `State`
Resets the scenario: creates a new scenario, seeds demo data (5 vehicles, 4 facilities, 20 tasks), discards all plans and incidents. Pauses playback.

### `POST /api/demo/advance-time` body: `{ "to": int }` → `State`
Advances simulated time to `to` (must be > current `now`). Marks assignments as IN_PROGRESS or COMPLETED. Pauses playback.

---

## Incidents

### `POST /api/incidents` body: `CreateIncident` → `State`
Records an incident. Pauses playback. Returns updated state. For `TRAFFIC_DELAY` and `ROAD_CLOSURE` the backend immediately recomputes detours for simulated vehicles of the active plan (see [tracking.md](tracking.md#automatic-detours)).

**`CreateIncident` fields:**

| Field | Required for | Description |
|---|---|---|
| `type` | always | See incident types in [data-model.md](data-model.md) |
| `vehicle_id` | VEHICLE_BREAKDOWN, VEHICLE_UNAVAILABLE | Target vehicle |
| `duration` | VEHICLE_UNAVAILABLE, TRAFFIC_DELAY, ROAD_CLOSURE | Duration in seconds |
| `road_id` | TRAFFIC_DELAY, ROAD_CLOSURE | Road segment id: `street:<name>` (whole street) or `way:<way>:<edge>` (part of a way between intersections), from `/api/map/roads/street` or `/api/map/roads/nearest` |
| `multiplier` | TRAFFIC_DELAY | Travel time multiplier (1.0–5.0) |
| `facility_id` | FACILITY_CAPACITY_CHANGE | Target facility |
| `quota` | FACILITY_CAPACITY_CHANGE | New quota value |
| `location` | WEATHER_DELAY and optional for TRAFFIC_DELAY or ROAD_CLOSURE | GPS point. For road events without `road_id` the nearest road segment is used. |
| `task` | NEW_TASK | `NewTask` object |

`NewTask` takes `priority` and `pickup` with optional `pickup_name`, `passenger_count`, `equipment`, `earliest_pickup`, and `latest_pickup`. The backend selects the facility with the shortest travel time from pickup and sets the arrival window. `GET /api/map/addresses?query=...` returns local matches with `name`, `lat`, and `lon`.

### `POST /api/incidents/{incident_id}/resolve` → `State`
Manually ends an active `TRAFFIC_DELAY` or `ROAD_CLOSURE` (sets `ended_at = now`). Pauses playback and recomputes detours, so vehicles return to the fastest route.

---

## Plans

### `POST /api/plans/generate` → `State`
Generates the initial plan using `MIN_DELAY` strategy. Fails with `409 ACTIVE_PLAN_EXISTS` if a plan already exists.

### `GET /api/plans` → `PlanSummary[]`
Returns all versioned (accepted) plans for the current scenario, newest first.

### `GET /api/plans/{plan_id}` → `PlanView`
Full plan detail including all assignments.

---

## Recommendations

### `POST /api/recommendations/generate` body: `Replan` → `Recommendations`
Generates up to 3 alternative plan recommendations (one per strategy). Requires an active plan. Returns the existing proposals if they already exist for the current revision.

**`Replan` fields:**
```json
{ "base_plan_id": "...", "expected_state_revision": 42 }
```
Fails with `409 STALE_STATE` if the scenario has changed since the client last fetched state.

### `GET /api/recommendations` → `RecommendationView[]`
All recommendations for the current scenario (including ACCEPTED/REJECTED history).

### `GET /api/recommendations/{rec_id}/explanation` → `Explanation`
Explains the consequences of accepting a proposed recommendation: verified `flags` (severity HIGH/MEDIUM/INFO), per-task `impacts`, and short `pros` / `cons` (≤ 3 each, a few words per line), written by a local Ollama model when available, otherwise rule-based. `source` is `OLLAMA` or `RULES`; `notice` says why the LLM text is missing or was shortened. Takes a few seconds with a local model; cached per recommendation. Fails with `409 STALE_STATE` for stale/decided recommendations and `404 RECOMMENDATION_NOT_FOUND`. See [advisor.md](advisor.md).

### `POST /api/recommendations/{rec_id}/accept` → `RecommendationView`
Accepts a recommendation: promotes its plan to ACTIVE. Pauses playback.

### `POST /api/recommendations/{rec_id}/reject` body: `{ "reason": "..." }` → `RecommendationView`
Rejects a recommendation with an optional reason.

---

## External Conditions

### `GET /api/conditions` → `SourceStatus[]`
Returns the status of all external data sources (OSM, OSRM, ARSO, NAP).

### `POST /api/conditions/refresh` → `SourceStatus[]`
Forces a refresh of all external sources. Throttled to once per 60 seconds.

---

## Map

### `GET /api/map/roads` → `RoadMap`
Returns road geometry for the Ljubljana area, including:
- `bounds` — `[south, west, north, east]`
- `layers` — road polylines grouped by rank (rank 0 = motorways, rank 3 = residential)
- `streets` — sorted list of all street names in the network (used for the incident search field)
- `timestamp` — OSM data timestamp

Heavily cached (`Cache-Control: public, max-age=3600`). The response is returned as a pre-serialised JSON blob (never deserialised on the backend).

### `GET /api/map/roads/street?name=<street>` → `RoadSegment`
Resolves a street name to the segment `street:<name>` covering all ways with that name. `404 ROAD_NOT_FOUND` for unknown names.

### `GET /api/map/roads/nearest?lat=<lat>&lon=<lon>` → `RoadSegment`
Returns the road part nearest to a clicked map point (`way:<way>:<edge>`, bounded by the nearest intersections). `404 ROAD_NOT_FOUND` if no road is close enough.

**`RoadSegment` fields:** `id`, `name`, `paths` (list of polylines `[[lat, lon], ...]`).

---

## Tracking

### `GET /api/tracking` → `TrackingFrame`
Current vehicle positions, statuses, and route paths. Polled every second by the frontend.

**`TrackingFrame` fields:**

| Field | Description |
|---|---|
| `scenario_id` | Current scenario id |
| `revision` | Current scenario revision |
| `now` | Current simulated time (seconds) |
| `mode` | `DEMO` or `GPS` |
| `playback` | `{ playing: bool, speed: 30|60|300 }` |
| `vehicles` | List of `TrackedVehicle` |
| `incidents` | Active road closures/delays for map overlay (`RoadEvent`: `id`, `road_id`, `type`, `name`, `paths`) |

**`TrackedVehicle` fields:**

| Field | Description |
|---|---|
| `id` | Vehicle id |
| `location` | `[lat, lon]` current position |
| `status` | WAITING / TO_PICKUP / AT_PICKUP / TO_HOSPITAL / AT_HOSPITAL / STOPPED / GPS |
| `task_id` | Currently active task |
| `to_pickup` | Full route geometry to pickup `[[lat, lon], ...]` |
| `to_hospital` | Full route geometry to facility `[[lat, lon], ...]` |
| `eta` | `{ destination: PICKUP\|HOSPITAL, seconds }` — time until the next stop |
| `recorded_at` | For GPS mode: timestamp of last fix |
| `stale` | For GPS mode: true if fix is >15 s old |

### `POST /api/tracking/playback` body: `{ "playing": bool, "speed": 30|60|300 }` → `Playback`
Controls simulation playback. Fails with `409 GPS_ENABLED` if GPS mode is active.

### `POST /api/tracking/gps` body: `GPSFix` headers: `Authorization: Bearer <key>` → 204
Records a real GPS fix. Only available when `RESCUEFLOW_GPS_KEY` is configured.

```json
{ "vehicle_id": "V1", "location": { "lat": 46.05, "lon": 14.50 }, "recorded_at": "2026-11-21T08:30:00Z" }
```

---

## Error Codes Reference

| Code | HTTP | Meaning |
|---|---|---|
| `ACTIVE_PLAN_EXISTS` | 409 | Use `generate` recommendation instead |
| `STALE_STATE` | 409 | Re-fetch state and retry |
| `SOLVER_BUSY` | 409 | Another solve is in progress |
| `PLAN_NOT_FOUND` | 404 | Plan id does not exist |
| `RECOMMENDATION_NOT_FOUND` | 404 | Recommendation id does not exist (explanation endpoint) |
| `VEHICLE_NOT_FOUND` | 404 | Vehicle id does not exist |
| `FACILITY_NOT_FOUND` | 404 | Facility id does not exist |
| `ROAD_NOT_FOUND` | 404 | Road segment id does not exist |
| `ROAD_REQUIRED` | 400 | Road closure/delay needs a road_id or location |
| `INCIDENT_NOT_FOUND` | 404 | Incident id does not exist |
| `INCIDENT_NOT_RESOLVABLE` | 400 | Only traffic delays and road closures can be resolved manually |
| `INCIDENT_ALREADY_ENDED` | 409 | Incident is no longer active |
| `TASK_REQUIRED` | 400 | NEW_TASK incident needs a task object |
| `PICKUP_IN_PAST` | 400 | Task pickup time is before current simulated time |
| `INVALID_TASK_TIME` | 400 | Task time window is inconsistent |
| `TIME_MUST_ADVANCE` | 400 | Advance-time target must be after current now |
| `ROAD_ROUTING_UNAVAILABLE` | 503 | OSRM is configured but unreachable |
| `GPS_ENABLED` | 409 | Cannot use playback in GPS mode |
| `GPS_UNAUTHORIZED` | 401 | Invalid GPS bearer token |
| `GPS_DISABLED` | 404 | GPS endpoint called but key not configured |
| `GPS_TIMESTAMP_INVALID` | 400 | GPS fix timestamp missing timezone or in the future |
| `VEHICLE_ALREADY_BROKEN` | 409 | Vehicle breakdown already recorded |
| `PLAYBACK_UNAVAILABLE` | 409 | No active plan or scenario is at HORIZON |
| `FACILITY_QUOTA_REQUIRED` | 400 | FACILITY_CAPACITY_CHANGE missing quota |
