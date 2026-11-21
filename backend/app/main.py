import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select

from app.api.schemas import (
    Advance, Baseline, CreateIncident, PlanSummary, PlanView, RecommendationView, Recommendations,
    Rejection, Replan, SourceStatus, State,
)
from app.db import Database
from app.models import Plan, Scenario
from app.planning.contracts import SolveBudget
from app.providers.conditions import Conditions
from app.services.decisions import decide
from app.services.planning import PlanningService, recommendation_history
from app.services.simulation import add_incident, advance
from app.services.state import problem, reset, scenario, view_plan, view_state


def create_app(db_path: Path | None = None, budget: SolveBudget = SolveBudget()) -> FastAPI:
    db_path = db_path or Path(os.environ.get("RESCUEFLOW_DB", "rescueflow.sqlite"))
    database = Database(db_path.absolute())
    planner = PlanningService(database, budget)
    conditions = Conditions()

    @asynccontextmanager
    async def lifespan(_):
        database.migrate()
        with database.session(write=True) as db:
            if not db.scalar(select(Scenario.id).where(Scenario.current)):
                reset(db)
        yield
        database.engine.dispose()

    app = FastAPI(title="RescueFlow", version="0.1.0", lifespan=lifespan)
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
        with database.session(write=True) as db:
            return view_state(db, reset(db))

    @app.post("/api/demo/advance-time")
    def advance_time(request: Advance) -> State:
        with database.session(write=True) as db:
            scope = scenario(db)
            advance(db, scope, request.to)
            return view_state(db, scope)

    @app.post("/api/incidents")
    def create_incident(request: CreateIncident) -> State:
        with database.session(write=True) as db:
            scope = scenario(db)
            add_incident(db, scope, request)
            return view_state(db, scope)

    @app.post("/api/plans/generate")
    def initial_plan() -> State:
        return planner.generate()

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
        return planner.generate(request)

    @app.get("/api/recommendations")
    def recommendations() -> list[RecommendationView]:
        with database.session() as db:
            return recommendation_history(db, scenario(db))

    @app.post("/api/recommendations/{rec_id}/accept")
    def accept(rec_id: str) -> RecommendationView:
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

    return app


app = create_app()
