# Backend

The backend is a Python 3.12 FastAPI application located in `backend/`. It is the system's single source of truth: all state lives in SQLite, all business logic runs here, and the frontend is a thin display layer.

---

## Libraries

| Library | Version | Purpose |
|---|---|---|
| **FastAPI** | 0.115.x | HTTP framework, automatic OpenAPI docs |
| **Uvicorn** | 0.34.x | ASGI server |
| **Pydantic** (v2) | 2.9.x | Data validation, serialisation for all domain objects |
| **SQLAlchemy** (v2) | 2.0.x | ORM, database sessions |
| **Alembic** | 1.16.x | Database migrations |
| **OR-Tools (ortools)** | 9.15.x | CP-SAT solver for schedule optimisation |
| **httpx** | 0.28.x | Async-capable HTTP client for OSRM, weather, traffic |

---

## Entry Point — `app/main.py`

`create_app()` builds the FastAPI application:

1. Opens the SQLite database via `Database`.
2. Instantiates `Conditions` (external data sources), `RoadMatrix` (OSRM), `PlanningService`, and `Tracking`.
3. Runs an async background `clock()` task that fires every second and calls `tracking.tick()` to advance simulated time when playback is running.
4. Registers all REST endpoints under `/api/`.

The `app` module-level variable is what uvicorn runs: `uvicorn app.main:app`.

---

## Layer Structure

```
main.py           ← HTTP routing only; no business logic
  └── services/   ← Business logic layer
        ├── state.py         Core reads and writes (scenario, plan, vehicles, tasks)
        ├── planning.py      Orchestrates CP-SAT solver runs
        ├── simulation.py    Advances time, records incidents
        ├── tracking.py      Computes real-time vehicle positions
        ├── decisions.py     Accept / reject recommendation
        └── metrics.py       Computes plan quality metrics
  └── planning/   ← Optimisation
        ├── contracts.py     All domain dataclasses and Pydantic models
        ├── cp_sat_planner.py CP-SAT scheduling model
        ├── snapshot_builder.py Builds the PlanningSnapshot for the solver
        └── validator.py      Post-solve feasibility checks
  └── providers/  ← External & internal data
        ├── roads.py         Embedded OSM Ljubljana road graph + Dijkstra
        ├── osrm.py          OSRM HTTP client (table + route endpoints)
        ├── haversine.py     Straight-line travel time estimation (fallback)
        ├── conditions.py    Aggregates source statuses (OSM, OSRM, ARSO, NAP)
        ├── arso.py          ARSO (Slovenian Met Office) weather parser
        ├── nap.py           Promet.si / NAP traffic feed parser
        └── http.py          Thin httpx wrapper
  └── api/        ← Pydantic request/response schemas
        └── schemas.py
  └── seed/       ← Demo scenario seed data
        └── scenario.py
  └── models.py   ← SQLAlchemy ORM models
  └── db.py       ← Database connection and session factory
```

---

## Database — `app/models.py` and `app/db.py`

SQLite is used via SQLAlchemy with a single-file database. All tables are created/migrated by Alembic on startup.

`Database` in `db.py` wraps the SQLAlchemy engine and exposes a `session()` context manager. Write sessions acquire a file-level lock to serialise concurrent writes (since SQLite supports only one writer at a time). Read sessions use `autocommit=True` for lower latency.

The database schema is described in detail in [data-model.md](data-model.md).

---

## Service: `state.py`

The central read/write service. Key functions:

- `scenario(db)` — returns the single active `Scenario` row.
- `active_plan(db, scope)` — returns the ACTIVE plan for the current scenario.
- `inputs(db, scope, plan, road_matrix)` — loads vehicles, tasks, facilities, incidents, and assignments and builds a `PlanningSnapshot` suitable for the solver or for display.
- `view_state(db, scope)` — assembles the full `State` response sent to the frontend.
- `reset(db)` — creates a new scenario, marks the old one inactive, and seeds demo data from `seed/scenario.py`.
- `save_plan` / `persist_snapshot` — persist a solved plan and its input snapshot.

---

## Service: `planning.py` — `PlanningService`

Wraps the CP-SAT solver with concurrency control (a `BoundedSemaphore(1)` ensures only one solve runs at a time).

**Initial plan generation** (`POST /api/plans/generate`):
- Runs the solver once with strategy `MIN_DELAY`.
- If the result is feasible, saves it as the ACTIVE plan.

**Recommendation generation** (`POST /api/recommendations/generate`):
- Runs the solver three times (once per strategy: `MIN_DELAY`, `MIN_CHANGES`, `MAX_BUFFER`).
- Saves each result as a DRAFT plan linked to a `Recommendation` record.
- The dispatcher can preview, accept, or reject each recommendation.

---

## Service: `simulation.py`

- `add_incident(db, scope, request)` — records a dispatcher-triggered event (breakdown, road closure, new task, etc.) and mutates the relevant entity (vehicle, facility).
- `advance(db, scope, until)` — fast-forwards simulated time: marks assignments as IN_PROGRESS or COMPLETED based on their planned timestamps relative to `until`.

---

## Service: `tracking.py` — `Tracking`

Manages the live tracking view. See [tracking.md](tracking.md) for the full algorithm.

---

## Service: `decisions.py`

`decide(db, scope, rec_id, accept)`:
- **Accept**: promotes a DRAFT recommendation plan to ACTIVE, demoting the previous active plan to SUPERSEDED.
- **Reject**: marks the recommendation as REJECTED, records the reason.

---

## Service: `metrics.py`

Calculates the `Metrics` object from a solved plan: late tasks, total delay, travel time, distance, vehicle changes, sequence changes, time shifts, buffer times. Also computes "affected" tasks — those in the active plan whose timing is threatened by incidents.

---

## Seed Data — `seed/scenario.py`

The demo scenario is generated procedurally:
- **5 vehicles** (V1–V5), each at a fixed Ljubljana GPS position, with varying equipment sets.
- **4 facilities** (F1–F4), representing care centres at different parts of Ljubljana.
- **20 tasks** (T01–T20), spread across 5 time waves, each tied to a facility with specific time windows.

The demo day starts at `2026-11-21T07:00:00Z` (08:00 Ljubljana local time). All internal times are seconds-since-start integers (0 = 08:00, 36000 = 18:00).

---

## External Conditions — `providers/conditions.py`

`Conditions` polls three optional external sources and surfaces them as `SourceStatus` entries:

| Source ID | Provider | Purpose |
|---|---|---|
| `arso` | ARSO (Slovenian Met Office) | Current weather in Ljubljana |
| `nap` | Promet.si / NAP feed | Live traffic events |
| `osrm` | Local OSRM instance | Confirms road routing is reachable |

These are informational only in the current demo — incidents must be manually injected by the dispatcher. Sources are refreshed on demand via `POST /api/conditions/refresh` and cached for 15–45 minutes depending on the source.
