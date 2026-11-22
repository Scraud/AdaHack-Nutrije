# Data Model

This document describes all domain entities: their fields, constraints, and how they relate to each other.

---

## Time Representation

All times are **integers in seconds since the scenario start** (`start_at`, which is `2026-11-21T07:00:00Z` = 08:00 Ljubljana time). The day's planning horizon is `HORIZON = 36000` seconds (08:00–18:00).

Times are stored as integers in the DB (inside JSON blobs) and transmitted as integers in the API. The frontend converts them to clock strings using `clock(start_at, seconds)`.

---

## Core Domain Objects (Pydantic models in `planning/contracts.py`)

### `Point`

```
lat: float  (-90 to 90)
lon: float  (-180 to 180)
```

A GPS coordinate. Used everywhere a location is needed.

---

### `Vehicle`

```
id: str
location: Point           # Current or last known location
capacity: int             # Max passengers
equipment: list[Equipment] # WHEELCHAIR | STRETCHER | OXYGEN
task_types: list[TaskType] # PLANNED_TRANSPORT | PRIORITY_TRANSPORT | EQUIPMENT_DELIVERY
available_at: int          # Earliest departure time (seconds)
broken: bool               # True if vehicle has broken down
unavailable: list[(start, end)]  # Scheduled unavailability windows
```

A vehicle can be assigned tasks only if it has the required equipment, supports the task type, is not broken, and is not in an unavailability window during the task.

---

### `Facility`

```
id: str
name: str
location: Point
quota: int       # Remaining patient capacity today
accepting: bool  # False if explicitly marked as not accepting
```

Each task is delivered to one facility. The solver enforces `sum(assigned tasks to facility) <= quota`.

---

### `Task`

```
id: str
type: TaskType          # PLANNED_TRANSPORT | PRIORITY_TRANSPORT | EQUIPMENT_DELIVERY
priority: Priority      # P1 (highest) | P2 | P3
pickup: Point           # Where to pick up the patient
facility_id: str        # Which facility to deliver to
passenger_count: int    # 1–8 passengers
equipment: list[Equipment]  # Required vehicle equipment
earliest_pickup: int    # Earliest the vehicle may arrive at pickup
latest_pickup: int|None # Latest allowed pickup (None = no hard deadline)
preferred_arrival: int  # Target delivery time (used for delay calculation)
latest_arrival: int     # Hard deadline for delivery at facility
pickup_service: int     # Time spent at pickup (default 240 s = 4 min)
dropoff_service: int    # Time spent at facility (default 240 s)
cleaning: int           # Vehicle cleaning time after dropoff (default 120 s)
actual_pickup: int|None # Set when simulated time advances past planned pickup
actual_arrival: int|None # Set when simulated time advances past planned dropoff
```

**Constraint:** `earliest_pickup <= preferred_arrival <= latest_arrival`

A task's total vehicle occupation time is:
```
deadhead + (planned_pickup − planned_departure) + pickup_service + travel_to_hospital + dropoff_service + cleaning
```

---

### `Assignment`

```
task_id: str
vehicle_id: str
planned_departure: int    # When vehicle leaves its prior location
planned_pickup: int       # When vehicle arrives at patient
planned_dropoff: int      # When vehicle arrives at facility
planned_end: int          # When vehicle is free again (after cleaning)
deadhead: int             # Travel seconds from anchor to pickup
status: PLANNED | IN_PROGRESS | COMPLETED
is_locked: bool           # Frozen = cannot be reassigned
distance_meters: int|None # Total route distance (if OSRM was used)
reroute: Reroute|None     # Automatic detour: {at, start, origin, leg: PICKUP|HOSPITAL|None}
planned_arrival: int      # Computed property = planned_dropoff
```

---

### `Incident`

```
id: int
type: IncidentType
occurred_at: int          # Simulated time when this was recorded
duration: int|None        # How long it lasts (seconds), None = permanent
vehicle_id: str|None      # For VEHICLE_BREAKDOWN / VEHICLE_UNAVAILABLE
facility_id: str|None     # For FACILITY_CAPACITY_CHANGE
task_id: str|None         # For NEW_TASK (links to created task)
location: Point|None      # For WEATHER_DELAY (or a clicked point for road events)
road_id: str|None         # For TRAFFIC_DELAY / ROAD_CLOSURE: street:<name> or way:<way>:<edge>
ended_at: int|None        # Set when a road event is resolved manually
radius_km: float          # For weather delays (default 1.5 km)
multiplier: float         # Travel time multiplier for TRAFFIC_DELAY (default 1.6×)
quota: int|None           # New quota for FACILITY_CAPACITY_CHANGE
source: str               # "SIMULATED" (manual) or external source name
```

Incident types:

| Type | Effect |
|---|---|
| `VEHICLE_BREAKDOWN` | Sets `vehicle.broken = True` |
| `VEHICLE_UNAVAILABLE` | Adds a `(start, end)` window to `vehicle.unavailable` |
| `TRAFFIC_DELAY` | Multiplies travel times on any selected road segment; triggers automatic detours |
| `ROAD_CLOSURE` | Removes any selected road segment from routing; triggers automatic detours |
| `WEATHER_DELAY` | Multiplies travel times for nodes within radius (legacy) |
| `NEW_TASK` | Creates a new Task record |
| `FACILITY_CAPACITY_CHANGE` | Updates `facility.quota` |

---

### `Metrics`

```
assigned: int               # Number of assigned tasks
unassigned: dict[Priority, int]  # Unassigned count per priority
late_tasks: int             # Tasks arriving after latest_arrival
delay_seconds: int          # Total seconds past preferred_arrival (assigned tasks only)
travel_seconds: int         # Total driving time
distance_meters: int|None   # Total distance (OSRM only)
vehicle_changes: int        # Tasks reassigned to a different vehicle vs previous plan
sequence_changes: int       # Tasks with a different predecessor in the route
time_changes: int           # Tasks whose pickup time shifted significantly
min_buffer_seconds: int     # Smallest slack before any task's latest_pickup
median_buffer_seconds: int  # Median slack
```

---

## Database Tables (SQLAlchemy models in `app/models.py`)

All entity payloads are stored as JSON blobs. The schema uses composite primary keys for scenario-scoped entities.

| Table | Key | Contents |
|---|---|---|
| `scenario_state` | `id` | Active scenario; `now`, `revision`, `start_at`, `current` flag |
| `vehicles` | `(id, scenario_id)` | JSON payload: `Vehicle` model |
| `facilities` | `(id, scenario_id)` | JSON payload: `Facility` model |
| `tasks` | `(id, scenario_id)` | JSON payload: `Task` model |
| `incidents` | `(id, scenario_id)` | JSON payload: `Incident` model |
| `input_snapshots` | `id` (SHA-256 hash) | JSON payload: full `PlanningSnapshot` serialisation |
| `plans` | `id` | `status` (ACTIVE/DRAFT/SUPERSEDED), `version`, `snapshot_id`, `result` JSON |
| `assignments` | `(plan_id, task_id)` | JSON payload: `Assignment` model |
| `recommendations` | `id` | Links `base_plan_id` ↔ `proposed_plan_id`, `status` |
| `decisions` | `id` | Links `recommendation_id`, `action` (ACCEPT/REJECT), `reason`, `actor` |
| `audit_log` | `id` | Action log with `action`, `actor`, `created_at`, `details` JSON |

### Entity lifecycle

```
Scenario ─── 1:N ─── Vehicle / Facility / Task / Incident
                │
                └── 1:N ─── Plan
                              │
                              ├── 1:1 ─── SnapshotRecord
                              ├── 1:N ─── AssignmentRecord
                              └── 1:N ─── Recommendation
                                              │
                                              └── 0:1 ─── Decision
```

Only one `Scenario` has `current = True` at a time (enforced by a partial unique index). Only one `Plan` per scenario has `status = 'ACTIVE'` at a time (also enforced by a partial unique index).

---

## Plan States

```
DRAFT      → created by recommendation generation, not yet chosen
ACTIVE     → the current operating plan (at most one per scenario)
SUPERSEDED → a previous ACTIVE plan that was replaced by an accepted recommendation
```

When a recommendation is accepted:
1. The recommended DRAFT plan becomes ACTIVE.
2. The previous ACTIVE plan becomes SUPERSEDED.
3. The `Recommendation` record is marked ACCEPTED.
4. A `Decision` record is created.
