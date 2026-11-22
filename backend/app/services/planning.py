from threading import BoundedSemaphore
from time import monotonic
from uuid import uuid4

from sqlalchemy import select

from app.api.schemas import Recommendations, Replan
from app.db import Database
from app.models import Recommendation
from app.planning.contracts import SolveBudget
from app.planning.cp_sat_planner import CpSatPlanner
from app.planning.snapshot_builder import MatrixProvider
from app.services.state import (
    active_plan, audit, inputs, persist_snapshot, problem, save_plan, scenario, snapshot_payload,
    view_recommendation, view_state,
)


class PlanningService:
    def __init__(self, database: Database, budget: SolveBudget, road_matrix: MatrixProvider | None = None):
        self.database = database
        self.planner = CpSatPlanner()
        self.capacity = BoundedSemaphore(1)
        self.budget = budget
        self.road_matrix = road_matrix

    def generate(self, request: Replan | None = None):
        if not self.capacity.acquire(blocking=False):
            raise problem(409, "SOLVER_BUSY", "Izračun že poteka.")
        try:
            return self._generate(request)
        finally:
            self.capacity.release()

    def _generate(self, request: Replan | None):
        began = monotonic()
        with self.database.session() as db:
            original = scenario(db)
            base = active_plan(db, original)
            if request is None and base is not None:
                raise problem(409, "ACTIVE_PLAN_EXISTS", "Aktivni plan že obstaja. Ustvarite predlog spremembe.")
            if request and (not base or base.id != request.base_plan_id or original.revision != request.expected_state_revision):
                raise problem(409, "STALE_STATE", "Stanje se je spremenilo. Osvežite podatke.")
            if request:
                proposed = db.scalars(select(Recommendation).where(
                    Recommendation.scenario_id == original.id, Recommendation.base_plan_id == base.id,
                    Recommendation.base_revision == original.revision, Recommendation.status == "PROPOSED",
                ).order_by(Recommendation.id)).all()
                if proposed:
                    items = [view_recommendation(db, original, rec) for rec in proposed]
                    return Recommendations(items=items, solver_statuses=[item.plan.solver_status for item in items],
                                           duration_ms=round((monotonic() - began) * 1000))
            snapshot, incidents, _ = inputs(db, original, base, self.road_matrix)
        snapshot_id, payload = snapshot_payload(snapshot, incidents)
        if request:
            candidates = self.planner.alternatives(snapshot, budget=self.budget)
        else:
            candidates = [self.planner.solve(snapshot, "MIN_DELAY", self.budget)]
        with self.database.session(write=True) as db:
            scope = scenario(db)
            current = active_plan(db, scope)
            if (scope.id, scope.revision, current.id if current else None) != (
                original.id, original.revision, base.id if base else None
            ):
                raise problem(409, "STALE_STATE", "Stanje se je med izračunom spremenilo.")
            if not request:
                candidate = candidates[0].plan
                if not candidate or candidate.blocking:
                    raise problem(409, candidates[0].status, "Izračun ni vrnil potrdivnega začetnega plana.")
                persist_snapshot(db, snapshot_id, payload)
                plan = save_plan(db, scope, candidate, snapshot_id, initial=True)
                scope.revision += 1
                audit(db, scope, "INITIAL_PLAN", plan_id=plan.id)
                return view_state(db, scope, self.road_matrix)
            items = []
            for result in candidates:
                if not result.plan:
                    continue
                persist_snapshot(db, snapshot_id, payload)
                plan = save_plan(db, scope, result.plan, snapshot_id)
                rec = Recommendation(id=uuid4().hex, scenario_id=scope.id, base_plan_id=base.id,
                                     proposed_plan_id=plan.id, base_revision=scope.revision, status="PROPOSED")
                db.add(rec)
                items.append(view_recommendation(db, scope, rec))
            audit(db, scope, "GENERATE_RECOMMENDATIONS", recommendation_ids=[rec.id for rec in items])
            return Recommendations(items=items, solver_statuses=[candidate.status for candidate in candidates],
                                   duration_ms=round((monotonic() - began) * 1000))


def recommendation_history(db, scope):
    rows = db.scalars(select(Recommendation).where(Recommendation.scenario_id == scope.id)
                      .order_by(Recommendation.base_revision.desc(), Recommendation.id))
    return [view_recommendation(db, scope, rec) for rec in rows]
