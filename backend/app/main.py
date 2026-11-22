import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Header, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from sqlalchemy import select

from app.api.schemas import (
    Advance, Baseline, CreateIncident, PlanSummary, PlanView, RecommendationView, Recommendations,
    Rejection, Replan, RoadMap, SourceStatus, State,
)
from app.db import Database
from app.models import Plan, Scenario
from app.planning.contracts import SolveBudget
from app.providers.conditions import Conditions
from app.providers.roads import road_network
from app.services.decisions import decide
from app.services.planning import PlanningService, recommendation_history
from app.services.simulation import add_incident, advance, restore_vehicle
from app.services.state import problem, reset, scenario, view_plan, view_state
from app.services.tracking import GPSFix, Playback, Tracking, TrackingFrame


def create_app(db_path: Path | None = None, budget: SolveBudget = SolveBudget()) -> FastAPI:
    db_path = db_path or Path(os.environ.get("RESCUEFLOW_DB", "rescueflow.sqlite"))
    database = Database(db_path.absolute())
    planner = PlanningService(database, budget)
    conditions = Conditions()
    tracking = Tracking(database, os.getenv("RESCUEFLOW_GPS_KEY"))

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
                    await asyncio.to_thread(tracking.tick)

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
                       allow_methods=["GET", "POST"], allow_headers=["Content-Type"])

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    @app.get("/api/state")
    def get_state() -> State:
        with database.session() as db:
            return view_state(db, scenario(db))

    @app.get("/api/metrics")
    def get_metrics() -> Baseline:
        return get_state().baseline

    @app.post("/api/demo/reset")
    def demo_reset() -> State:
        tracking.pause()
        with database.session(write=True) as db:
            return view_state(db, reset(db))

    @app.post("/api/demo/advance-time")
    def advance_time(request: Advance) -> State:
        tracking.pause()
        with database.session(write=True) as db:
            scope = scenario(db)
            advance(db, scope, request.to)
            return view_state(db, scope)

    @app.post("/api/incidents")
    def create_incident(request: CreateIncident) -> State:
        tracking.pause()
        with database.session(write=True) as db:
            scope = scenario(db)
            add_incident(db, scope, request)
            return view_state(db, scope)

    @app.post("/api/plans/generate")
    def initial_plan() -> State:
        tracking.pause()
        return planner.generate()

    @app.post("/api/vehicles/{vehicle_id}/restore")
    def vehicle_restore(vehicle_id: str) -> State:
        tracking.pause()
        with database.session(write=True) as db:
            scope = scenario(db)
            restore_vehicle(db, scope, vehicle_id)
            return view_state(db, scope)

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

    @app.post("/api/recommendations/{rec_id}/accept")
    def accept(rec_id: str) -> RecommendationView:
        tracking.pause()
        with database.session(write=True) as db:
            return decide(db, scenario(db), rec_id, accept=True)

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

    @app.get("/api/tracking")
    def vehicle_tracking() -> TrackingFrame:
        return tracking.frame()

    @app.post("/api/tracking/playback")
    def playback(request: Playback) -> Playback:
        return tracking.control(request)

    @app.post("/api/tracking/gps", status_code=204)
    def gps(request: GPSFix, authorization: str | None = Header(default=None)):
        tracking.record_gps(request, authorization)
        return Response(status_code=204)

    return app


app = create_app()
