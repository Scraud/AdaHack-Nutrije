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

- `add_incident(db, scope, request)` — records a dispatcher-triggered event (breakdown, road closure, new task, etc.) and mutates the relevant entity (vehicle, facility). Road events are validated against `RoadNetwork.segment()`; a `location` without `road_id` is resolved to the nearest road.
- `resolve_incident(db, scope, incident_id)` — manually ends an active delay/closure by setting `ended_at`.
- `reroute(db, scope, road_matrix)` — after adding or resolving a road event, recomputes detours and timings for the active plan without changing vehicle assignments (see [tracking.md](tracking.md#automatic-detours)).
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

## Service: `advisor.py` — `Advisor`

Explains a proposed recommendation without changing it. `recommendation_facts()` compares the proposal with the active plan under current conditions and computes verified flags (tight deadlines, cascades along a vehicle's chain, later arrivals, vehicles sharing an active traffic jam, facility bunching, crew notices). `Advisor.explain()` optionally sends these facts to a local Ollama model (`RESCUEFLOW_OLLAMA_URL`, `RESCUEFLOW_OLLAMA_MODEL`) for short Slovenian pros and cons (≤ 3 each), drops lines that are too long or mention IDs not in the facts, keeps P1 risks in the cons, and falls back to the rule-based pros/cons when Ollama is unavailable. Details: [advisor.md](advisor.md).

---

## Service: `metrics.py`

Calculates the `Metrics` object from a solved plan: late tasks, total delay, travel time, distance, vehicle changes, sequence changes, time shifts, buffer times. Also computes "affected" tasks — those in the active plan whose timing is threatened by incidents.

---

## Seed Data — `seed/scenario.py`

The demo scenario is generated procedurally:
- **5 vehicles** (V1–V5), each at a fixed Ljubljana GPS position. Only V3, V4 and V5 carry oxygen.
- **4 facilities** (F1–F4), representing care centres at different parts of Ljubljana, each with a daily quota of 12 arrivals (F1 receives 8 seeded tasks, the others 4). A new task goes to the nearest centre that still accepts and has quota left.
- **20 tasks** (T01–T20) in 4 waves of 5 (08:22, 10:20, 12:45, 15:10). Each task has only a desired pickup; its latest pickup follows from priority (P2 +45 min, P3 +2 h, P1 none).
- Every wave asks for **four oxygen transports within minutes** (P3, P2, P1, P2) for three oxygen vehicles, plus one wheelchair/stretcher transport for V1/V2. Priority therefore decides who waits: in the initial plan red waits 0 min, medium almost always 0, low up to about 30 min. `tests/test_priority_rules.py` checks this.

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
