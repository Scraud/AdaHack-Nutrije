import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Header, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select

from app.api.schemas import (
    Advance, DemoClock, CreateScheduledTask, Baseline, CreateIncident, Explanation, PickupAddress, PlanSummary, PlanView, RecommendationView,
    ManualMove, ManualSolution, NewVehicle, Recommendations, Rejection, Replan, RoadMap, RoadSegment, SourceStatus, State, VehicleSettings,
)
from app.db import Database
from app.models import IncidentRecord, Plan, Scenario
from app.planning.contracts import SolveBudget
from app.providers.conditions import Conditions
from app.providers.osrm import RoadMatrix, RoadRoutingUnavailable
from app.providers.roads import road_network
from app.services.advisor import Advisor, recommendation_facts
from app.services.decisions import decide
from app.services.fleet import add_vehicle, remove_vehicle, update_vehicle
from app.services.manual_planning import evaluate_manual, save_manual
from app.services.planning import PlanningService, recommendation_history
from app.services.simulation import add_incident, advance, restore_vehicle, resolve_incident, set_demo_clock
from app.services.scheduling import create_scheduled_task
from app.services.state import problem, reset, scenario, timestamp, view_plan, view_state
from app.services.tracking import GPSFix, Playback, Tracking, TrackingFrame


def create_app(db_path: Path | None = None, budget: SolveBudget = SolveBudget(),
               advisor: Advisor | None = None) -> FastAPI:
    db_path = db_path or Path(os.environ.get("RESCUEFLOW_DB", "rescueflow.sqlite"))
    advisor = advisor or Advisor.from_env()
    database = Database(db_path.absolute())
    conditions = Conditions()
    road_matrix = RoadMatrix(conditions.osrm_url) if conditions.osrm_url else None
    planner = PlanningService(database, budget, road_matrix)
    tracking = Tracking(database, os.getenv("RESCUEFLOW_GPS_KEY"), road_matrix)

    @asynccontextmanager
    async def lifespan(_):
        database.migrate()
        with database.session(write=True) as db:
            if not db.scalar(select(Scenario.id).where(Scenario.current)):
                reset(db)
        stop = asyncio.Event()

        async def clock():
            while not stop.is_set():
                try:
                    await asyncio.wait_for(stop.wait(), timeout=1)
                except TimeoutError:
                    try:
                        await asyncio.to_thread(tracking.tick)
                    except RoadRoutingUnavailable:
                        tracking.pause()

        player = asyncio.create_task(clock())
        try:
            yield
        finally:
            stop.set()
            await player
            database.engine.dispose()

    app = FastAPI(title="RescueFlow", version="0.1.0", lifespan=lifespan)
    app.add_middleware(GZipMiddleware, minimum_size=2048)
    app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:4200", "http://127.0.0.1:4200"],
                       allow_methods=["GET", "POST", "PUT", "DELETE"], allow_headers=["Content-Type"])

    @app.exception_handler(RoadRoutingUnavailable)
    async def road_routing_unavailable(_request: Request, _error: RoadRoutingUnavailable):
        error = problem(503, "ROAD_ROUTING_UNAVAILABLE", "Cestna matrika ni dosegljiva. Preverite lokalni OSRM.")
        return JSONResponse(status_code=error.status_code, content={"detail": error.detail})

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    @app.get("/api/state")
    def get_state() -> State:
        with database.session() as db:
            return view_state(db, scenario(db), road_matrix)

    @app.get("/api/metrics")
    def get_metrics() -> Baseline:
        return get_state().baseline

    @app.post("/api/demo/reset")
    def demo_reset() -> State:
        tracking.pause()
        with database.session(write=True) as db:
            return view_state(db, reset(db), road_matrix)

    @app.post("/api/demo/advance-time")
    def advance_time(request: Advance) -> State:
        tracking.pause()
        with database.session(write=True) as db:
            scope = scenario(db)
            advance(db, scope, request.to, road_matrix)
            return view_state(db, scope, road_matrix)

    @app.post("/api/tasks")
    def create_task(request: CreateScheduledTask) -> State:
        tracking.pause()
        with database.session(write=True) as db:
            scope = scenario(db)
            create_scheduled_task(db, scope, request)
            return view_state(db, scope, road_matrix)

    @app.post("/api/incidents")
    def create_incident(request: CreateIncident) -> State:
        tracking.pause()
        with database.session(write=True) as db:
            scope = scenario(db)
            add_incident(db, scope, request, road_matrix)
            return view_state(db, scope, road_matrix)

    @app.post("/api/incidents/{incident_id}/resolve")
    def remove_incident(incident_id: int) -> State:
        tracking.pause()
        with database.session(write=True) as db:
            scope = scenario(db)
            resolve_incident(db, scope, incident_id, road_matrix)
            return view_state(db, scope, road_matrix)

    @app.post("/api/demo/clock")
    def demo_clock(request: DemoClock) -> State:
        tracking.pause()
        with database.session(write=True) as db:
            scope = scenario(db)
            set_demo_clock(db, scope, request.to, road_matrix)
            return view_state(db, scope, road_matrix)

    @app.post("/api/plans/generate")
    def initial_plan() -> State:
        tracking.pause()
        return planner.generate()

    @app.post("/api/plans/manual-move")
    def manual_move(request: ManualMove) -> State:
        tracking.pause()
        with database.session(write=True) as db:
            scope = scenario(db)
            save_manual(db, scope, evaluate_manual(db, scope, request, [request], road_matrix))
            return view_state(db, scope, road_matrix)

    def review_incident(db, scope, incident_id):
        incident = db.get(IncidentRecord, incident_id)
        if incident is None or incident.scenario_id != scope.id:
            raise problem(404, "INCIDENT_NOT_FOUND", "Dogodek ne obstaja.")
        return incident

    @app.post("/api/incidents/{incident_id}/manual-preview")
    def manual_preview(incident_id: int, request: ManualSolution) -> PlanView:
        with database.session() as db:
            scope = scenario(db)
            review_incident(db, scope, incident_id)
            active, candidate, snapshot_id, _, _ = evaluate_manual(
                db, scope, request, request.moves, road_matrix, cascade=True,
            )
            return PlanView(id=f"manual:{active.id}", version=None, status="DRAFT",
                            created_at=timestamp(), snapshot_id=snapshot_id, **candidate.model_dump())

    @app.post("/api/incidents/{incident_id}/manual-solution")
    def manual_solution(incident_id: int, request: ManualSolution) -> State:
        tracking.pause()
        with database.session(write=True) as db:
            scope = scenario(db)
            incident = review_incident(db, scope, incident_id)
            if incident.payload.get("status") == "RESOLVED":
                raise problem(409, "STALE_STATE", "Dogodek je že zaključen.")
            evaluation = evaluate_manual(db, scope, request, request.moves, road_matrix, cascade=True)
            if any(item.task_id == incident.payload.get("task_id") for item in evaluation[1].unassigned):
                raise problem(409, "MANUAL_MOVE_INVALID", "Naloga dogodka še nima dodeljenega vozila.")
            save_manual(db, scope, evaluation, incident)
            return view_state(db, scope, road_matrix)

    @app.post("/api/vehicles/{vehicle_id}/restore")
    def vehicle_restore(vehicle_id: str) -> State:
        tracking.pause()
        with database.session(write=True) as db:
            scope = scenario(db)
            restore_vehicle(db, scope, vehicle_id)
            return view_state(db, scope, road_matrix)

    @app.post("/api/vehicles")
    def vehicle_add(request: NewVehicle) -> State:
        tracking.pause()
        with database.session(write=True) as db:
            scope = scenario(db)
            add_vehicle(db, scope, request)
            return view_state(db, scope, road_matrix)

    @app.put("/api/vehicles/{vehicle_id}")
    def vehicle_update(vehicle_id: str, request: VehicleSettings) -> State:
        tracking.pause()
        with database.session(write=True) as db:
            scope = scenario(db)
            update_vehicle(db, scope, vehicle_id, request)
            return view_state(db, scope, road_matrix)

    @app.delete("/api/vehicles/{vehicle_id}")
    def vehicle_remove(vehicle_id: str) -> State:
        tracking.pause()
        with database.session(write=True) as db:
            scope = scenario(db)
            remove_vehicle(db, scope, vehicle_id)
            return view_state(db, scope, road_matrix)

    @app.get("/api/plans")
    def plans() -> list[PlanSummary]:
        with database.session() as db:
            rows = db.scalars(select(Plan).where(Plan.scenario_id == scenario(db).id, Plan.version.is_not(None))
                              .order_by(Plan.version.desc()))
            return [PlanSummary(id=row.id, version=row.version, status=row.status, created_at=row.created_at,
                                strategy=row.result["strategy"], metrics=row.result["metrics"]) for row in rows]

    @app.get("/api/plans/{plan_id}")
    def plan_detail(plan_id: str) -> PlanView:
        with database.session() as db:
            row = db.get(Plan, plan_id)
            if not row or row.scenario_id != scenario(db).id:
                raise problem(404, "PLAN_NOT_FOUND", "Plan ne obstaja.")
            return view_plan(db, row)

    @app.post("/api/recommendations/generate")
    def generate_recommendations(request: Replan) -> Recommendations:
        tracking.pause()
        return planner.generate(request)

    @app.get("/api/recommendations")
    def recommendations() -> list[RecommendationView]:
        with database.session() as db:
            return recommendation_history(db, scenario(db))

    @app.get("/api/recommendations/{rec_id}/explanation")
    def explanation(rec_id: str) -> Explanation:
        with database.session() as db:
            rules, payload = recommendation_facts(db, scenario(db), rec_id, road_matrix)
        return advisor.explain(rules, payload)

    @app.post("/api/recommendations/{rec_id}/accept")
    def accept(rec_id: str) -> RecommendationView:
        tracking.pause()
        with database.session(write=True) as db:
            return decide(db, scenario(db), rec_id, accept=True, road_matrix=road_matrix)

    @app.post("/api/recommendations/{rec_id}/reject")
    def reject(rec_id: str, request: Rejection | None = None) -> RecommendationView:
        with database.session(write=True) as db:
            return decide(db, scenario(db), rec_id, accept=False, reason=request.reason if request else "")

    @app.get("/api/conditions")
    def source_status() -> list[SourceStatus]:
        return conditions.get()

    @app.post("/api/conditions/refresh")
    def refresh_sources() -> list[SourceStatus]:
        return conditions.refresh()

    @app.get("/api/map/roads", response_model=RoadMap)
    def road_map():
        return Response(road_network().basemap(), media_type="application/json",
                        headers={"Cache-Control": "public, max-age=3600"})

    @app.get("/api/map/addresses")
    def addresses(query: str = Query(min_length=2, max_length=200)) -> list[PickupAddress]:
        return road_network().find_addresses(query)

    @app.get("/api/map/roads/street", response_model=RoadSegment)
    def road_street(name: str):
        roads = road_network()
        segment = roads.segment(f"street:{name}")
        if segment is None:
            raise problem(404, "ROAD_NOT_FOUND", "Ulica ne obstaja v cestnem omrežju.")
        return roads.segment_json(segment)

    @app.get("/api/map/roads/nearest", response_model=RoadSegment)
    def nearest_road(lat: float, lon: float):
        roads = road_network()
        segment = roads.nearest(lat, lon)
        if segment is None:
            raise problem(404, "ROAD_NOT_FOUND", "Na tej lokaciji ni odseka cestnega omrežja.")
        return roads.segment_json(segment)

    @app.get("/api/tracking")
    def vehicle_tracking(plan_id: str | None = None) -> TrackingFrame:
        return tracking.frame(plan_id)

    @app.post("/api/tracking/playback")
    def playback(request: Playback) -> Playback:
        return tracking.control(request)

    @app.post("/api/tracking/gps", status_code=204)
    def gps(request: GPSFix, authorization: str | None = Header(default=None)):
        tracking.record_gps(request, authorization)
        return Response(status_code=204)

    return app


app = create_app()
