# Tracking — Vehicle Position Simulation

The tracking system animates ambulances on the map in real time. It computes where each vehicle physically is at the current simulated time and returns the full path geometry so the frontend can draw the route.

---

## Files

`backend/app/services/tracking.py` — `Tracking` class and `demo_positions()` function.

---

## Two Modes

### DEMO mode (default)

Vehicle positions are computed by interpolating along the planned route based on simulated time. No real GPS data is involved. The dispatcher controls playback speed.

### GPS mode

Enabled when `RESCUEFLOW_GPS_KEY` is set. Real vehicles push GPS fixes to `POST /api/tracking/gps` with a bearer token. The tracking frame shows the last received fix for each vehicle. Playback controls are disabled in GPS mode.

---

## Simulated Time

The scenario has a `now` field (integer seconds since start). It advances in two ways:

1. **Manual advance** — dispatcher clicks a time jump button → `POST /api/demo/advance-time` → `simulation.advance(db, scope, until)`.
2. **Playback** — the backend's async clock loop calls `tracking.tick()` once per second (real time). `tick()` multiplies real elapsed seconds by `playback.speed` (30×, 60×, or 300×) and calls `simulation.advance()` with the incremented time.

`simulation.advance()` marks assignments as IN_PROGRESS or COMPLETED based on their planned timestamps relative to `until`, updating the DB.

---

## Position Interpolation — `demo_positions()`

Called whenever the frontend polls `GET /api/tracking`. For each vehicle:

1. **Find the upcoming assignment** — scan the vehicle's route chronologically. Skip COMPLETED assignments (the vehicle's location becomes the facility it last dropped off at). Take the first non-completed, non-future assignment.

2. **Determine effective time** — if the vehicle is broken or its task is blocked (e.g. no detour exists), find the earliest incident that caused the block and freeze the vehicle's position at that moment. Road closures with a valid detour do **not** stop the vehicle (see [Automatic Detours](#automatic-detours)).

3. **Compute route legs:**
   - `approach` = road path from vehicle's current location to task pickup
   - `delivery` = road path from pickup to destination facility
   - If the assignment has `reroute`, the rerouted leg is drawn from `reroute.origin` under the conditions active at `reroute.at`, and its progress starts at `reroute.start` (`leg = PICKUP` → approach, `leg = HOSPITAL` → delivery).

4. **Interpolate position on the path** using `position_on_path(path, progress, fallback)`:
   - Calculates cumulative Euclidean length of path segments.
   - Walks segments until `total_length × progress` is consumed.
   - Interpolates linearly within the segment where it falls.

5. **Assign status and progress fraction** based on `state.now` vs the assignment timestamps:

   | `now` range | Status | Progress |
   |---|---|---|
   | `< planned_departure` | `WAITING` | — (at current location) |
   | `planned_departure` to `planned_pickup` | `TO_PICKUP` | `(now − departure) / (pickup − departure)` |
   | `planned_pickup` to `pickup + pickup_service` | `AT_PICKUP` | 0 (at start of delivery path) |
   | `pickup + pickup_service` to `planned_dropoff` | `TO_HOSPITAL` | `(now − pickup_end) / (dropoff − pickup_end)` |
   | `≥ planned_dropoff` | `AT_HOSPITAL` | 1 (end of delivery path) |

   If stopped (broken / blocked): status overridden to `STOPPED`.

6. **Return `TrackedVehicle`** with:
   - `location` — interpolated `(lat, lon)`
   - `status` — one of WAITING / TO_PICKUP / AT_PICKUP / TO_HOSPITAL / AT_HOSPITAL / STOPPED
   - `to_pickup` — full approach path (for the frontend to draw)
   - `to_hospital` — full delivery path (drawn as dashed line)
   - `task_id` — which task this vehicle is working on

---

## Path Source

The path geometry is obtained via a `road_path` callable that is passed into `demo_positions()`. It is selected in `Tracking.frame()`:

- If the active plan was solved with OSRM (`provider == "OSRM"`) and OSRM is still available → `self.road_matrix.path`
- Otherwise → `roads.road_path(a, b, effects=roads.effects(active_conditions(...)))`

The road effects (closures/delays) used for path drawing are those that were active **when the plan was generated**, not the current ones. This ensures the visualised path matches the planned route. The exception are rerouted legs, which use the conditions from the moment of the detour.

---

## Automatic Detours

`simulation.reroute()` runs after a `TRAFFIC_DELAY` / `ROAD_CLOSURE` is added (`add_incident`) or resolved (`resolve_incident`):

1. Computes each vehicle's current position with `demo_positions(..., respect_blocking=False)`.
2. For the IN_PROGRESS assignment: routes from the current position to the pickup (`leg = PICKUP`) or, after pickup, to the facility (`leg = HOSPITAL`) with `RoadNetwork.route()` under the current conditions, and updates `planned_pickup` / `planned_dropoff` / `planned_end`, `deadhead` and `distance_meters`.
3. Re-times the following PLANNED assignments of the same vehicle (departure from the previous facility, new travel times).
4. Stores the detour in `Assignment.reroute = {at, start, origin, leg}` and writes an `AUTO_DETOUR` audit entry.

The vehicle and task order chosen by the dispatcher are never changed; an accepted recommendation still overrides everything. If no detour exists, the assignment stays unchanged and is reported as blocked for manual coordination. `snapshot_builder` skips the approach/loaded travel check for the rerouted leg, because its times already come from the detour.

---

## Frontend Animation and Map Behaviour

- `packages/react-views/src/route-motion.ts` measures the route legs, projects the vehicle onto them and computes its progress per status.
- `dispatch-map.tsx` animates the marker along the route between the 1 s frames (`requestAnimationFrame`, duration = measured frame interval clamped to 250–1600 ms) and shortens the polylines so the already-driven part disappears. Vehicles without a path (GPS) are interpolated linearly. A changed route makes the marker jump instead of animating.
- The pickup pin is hidden once the patient has been picked up (`TO_HOSPITAL`, `AT_HOSPITAL` or `actual_arrival` set).

Details: [docs/vehicle-motion.md](../docs/vehicle-motion.md).

---

## Frontend Polling

The frontend polls `GET /api/tracking` every 1 second via `DispatchStore.refreshTracking()`. When the returned `revision` or `scenario_id` differs from the current state, it also re-fetches `GET /api/state` to pick up changes (new incidents, new plan, etc.).

---

## Playback Controls

`POST /api/tracking/playback` accepts `{ playing: bool, speed: 30|60|300 }`.

- `playing: true` — starts the background clock; each real second advances simulated time by `speed` seconds.
- `playing: false` — pauses.
- Speed options: 30× (slow demo), 60× (1 sim-minute per real second), 300× (fast forward).

Playback is automatically paused on any state-mutating action (incident creation, plan generation, time advance) to prevent race conditions.
