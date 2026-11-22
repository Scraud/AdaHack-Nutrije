# RescueFlow — System Overview

RescueFlow is a web-based dispatcher dashboard for coordinating non-emergency medical transport (ambulance scheduling) in Ljubljana, Slovenia. A dispatcher uses it to plan which vehicle picks up which patient, when, and to which facility, in a simulated day-long scenario. The system can inject disruptions (traffic jams, breakdowns, new patients), re-optimise the schedule, and animate vehicle positions on a live map.

---

## High-Level Architecture

```
Browser (Angular + React)
        │
        │  HTTP JSON  (REST over /api/*)
        ▼
   FastAPI backend  (Python)
        │
        ├── SQLite database  (via SQLAlchemy / Alembic)
        ├── CP-SAT solver    (Google OR-Tools)
        ├── Road network     (embedded OSM Ljubljana graph)
        └── OSRM             (optional external routing engine)
```

The frontend and backend are built as two separate Docker images that are composed together. The frontend is served by nginx and proxies `/api/*` calls to the backend. OSRM runs as an optional third container.

---

## Repository Layout

```
AdaHack-Nutrije/
├── backend/            Python 3.12 FastAPI application
│   ├── app/
│   │   ├── api/        Request/response schemas (Pydantic)
│   │   ├── planning/   Solver contracts, CP-SAT planner, snapshot builder
│   │   ├── providers/  Road network, routing, weather, traffic, haversine
│   │   ├── seed/       Demo scenario data (vehicles, facilities, tasks)
│   │   └── services/   Business logic (planning, tracking, simulation, state)
│   ├── alembic/        Database migrations
│   └── tests/          Pytest test suite
├── frontend/           Angular 19 monorepo
│   ├── apps/dispatcher Angular application (components, store, templates)
│   └── packages/
│       ├── contracts/  Auto-generated TypeScript API types + utilities
│       └── react-views React components (map, timeline) embedded in Angular
├── routing/            Scripts to build the OSRM road graph for Slovenia
├── docs/               Original demo scenario description and rules
├── documentation/      THIS folder – comprehensive code documentation
└── compose.yaml        Docker Compose for local/production deployment
```

---

## Documents in this folder

| File | Contents |
|---|---|
| [overview.md](overview.md) | This file – architecture, repo layout, deployment |
| [backend.md](backend.md) | Python backend: layers, services, data models, API endpoints |
| [planning.md](planning.md) | CP-SAT scheduler: how the optimiser works, strategies, constraints |
| [routing.md](routing.md) | Road network: OSM graph, OSRM, path finding, travel matrices |
| [tracking.md](tracking.md) | Real-time simulation: position interpolation, playback clock |
| [frontend.md](frontend.md) | Angular/React frontend: state store, map, timeline, incident form |
| [data-model.md](data-model.md) | All domain types: Vehicle, Task, Facility, Assignment, Incident, Plan |
| [api.md](api.md) | Full REST API reference with request/response shapes |

---

## Deployment

### Docker Compose (recommended)

```
docker compose up --build
```

The app is served at `http://localhost:8080` by default. The backend stores its SQLite database in a Docker volume (`rescueflow-data`).

**Environment variables** (set in `.env` or compose override):

| Variable | Default | Purpose |
|---|---|---|
| `RESCUEFLOW_DB` | `/data/rescueflow.sqlite` | Path to the SQLite file |
| `RESCUEFLOW_OSRM_URL` | _(empty)_ | URL of OSRM instance; enables real road routing |
| `RESCUEFLOW_NAP_URL` | _(empty)_ | URL of a NAP traffic feed (Promet.si) |
| `RESCUEFLOW_NAP_TOKEN` | _(empty)_ | Bearer token for the NAP feed |
| `RESCUEFLOW_GPS_KEY` | _(empty)_ | Static key for real-vehicle GPS push endpoint |
| `RESCUEFLOW_PORT` | `8080` | Host port the frontend is exposed on |

### Optional OSRM routing

To enable real road routing (instead of the built-in OSM graph):

```sh
sh routing/prepare.sh
RESCUEFLOW_OSRM_URL=http://osrm:5000 docker compose --profile routing up --build
```

`prepare.sh` downloads the Slovenia OSM extract from Geofabrik and preprocesses it with the CH (Contraction Hierarchies) algorithm. The OSRM container exposes the routing API on port 5000 (internal only).

### Development (without Docker)

**Backend:**
```sh
cd backend
pip install -e ".[test]"
uvicorn app.main:app --reload --port 8000
```

**Frontend:**
```sh
cd frontend
npm install
npx ng serve
```

The Angular dev server runs on port 4200 and proxies `/api/*` to `localhost:8000` (see `proxy.conf.json`).
