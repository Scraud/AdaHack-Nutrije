from dataclasses import asdict
from datetime import UTC, datetime
from hashlib import sha256
from json import dumps
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas import Baseline, PlanView, RecommendationView, State, VehicleView
from app.models import (
    AssignmentRecord, Audit, Decision, FacilityRecord, IncidentRecord, Plan, Recommendation,
    Scenario, SnapshotRecord, TaskRecord, VehicleRecord,
)
from app.planning.contracts import Assignment, Candidate, Facility, Incident, PlanningSnapshot, Point, Task, Vehicle
from app.planning.snapshot_builder import MatrixProvider, after_repositioning, build_snapshot, compatible, routes
from app.seed.scenario import DEMO_START, demo_data
from app.services.metrics import project_existing


def timestamp() -> str:
    return datetime.now(UTC).isoformat()


def scenario(db: Session) -> Scenario:
    return db.scalars(select(Scenario).where(Scenario.current)).one()


def active_plan(db: Session, scope: Scenario) -> Plan | None:
    return db.scalar(select(Plan).where(Plan.scenario_id == scope.id, Plan.status == "ACTIVE"))


def audit(db: Session, scope: Scenario, action: str, **details):
    db.add(Audit(scenario_id=scope.id, actor="dispatcher", action=action, created_at=timestamp(), details=details))


def reset(db: Session) -> Scenario:
    previous = db.scalar(select(Scenario).where(Scenario.current))
    if previous:
        previous.current = False
        db.flush()
    scope = Scenario(id=uuid4().hex, start_at=DEMO_START, now=0, revision=0, current=True)
    db.add(scope)
    db.flush()
    for model, entities in zip((VehicleRecord, FacilityRecord, TaskRecord), demo_data(), strict=True):
        db.add_all(model(id=value.id, scenario_id=scope.id, payload=value.model_dump(mode="json"))
                   for value in entities)
    audit(db, scope, "RESET", previous_scenario_id=previous.id if previous else None)
    return scope


def entities(db: Session, scope: Scenario, model, schema):
    rows = db.scalars(select(model).where(model.scenario_id == scope.id).order_by(model.id))
    return [schema.model_validate(row.payload) for row in rows]


def assignments(db: Session, plan: Plan | None) -> list[Assignment]:
    if not plan:
        return []
    rows = db.scalars(select(AssignmentRecord).where(AssignmentRecord.plan_id == plan.id))
    return sorted((Assignment.model_validate(row.payload) for row in rows),
                  key=lambda a: (a.vehicle_id, a.planned_departure, a.task_id))


def inputs(db: Session, scope: Scenario, plan: Plan | None, road_matrix: MatrixProvider | None = None, *,
           preserve_active_timing: bool = False, preview: bool = False):
    vehicles = entities(db, scope, VehicleRecord, Vehicle)
    tasks = entities(db, scope, TaskRecord, Task)
    facilities = entities(db, scope, FacilityRecord, Facility)
    incidents = entities(db, scope, IncidentRecord, Incident)
    rows = assignments(db, plan)
    saved = db.get(SnapshotRecord, plan.snapshot_id).payload if plan else {}
    provider = saved.get("provider")
    if preview:
        origins = {row["id"]: Vehicle.model_validate(row) for row in saved.get("vehicles", [])
                   if row.get("repositioned_at") == scope.now}
        vehicles = [origins.get(vehicle.id, vehicle) for vehicle in vehicles]

    active_matrix = road_matrix if not plan or provider == "OSRM" else None
    if preserve_active_timing:
        snapshot = build_snapshot(scope.now, vehicles, tasks, facilities, rows, incidents, active_matrix,
                                  legacy_timing=provider == "HAVERSINE")
        return snapshot, incidents, rows

    by_task = {task.id: task for task in tasks}
    by_vehicle = {vehicle.id: vehicle for vehicle in vehicles}
    committed = {row.task_id for row in rows if row.status != "PLANNED" or row.is_locked}
    urgent = [task for task in tasks if task.arrival_asap and task.id not in committed
              and task.earliest_pickup <= scope.now and task.actual_pickup is None]
    releasable = {row.vehicle_id: row.task_id for row in rows if row.status == "IN_PROGRESS" and not row.is_locked
                  and by_task[row.task_id].priority != "P1" and by_task[row.task_id].actual_pickup is None
                  and any(compatible(by_vehicle[row.vehicle_id], task) for task in urgent)}
    released = frozenset()
    if releasable:
        from app.services.tracking import demo_positions, planned_path

        current = build_snapshot(scope.now, vehicles, tasks, facilities, rows, incidents, active_matrix,
                                 legacy_timing=provider == "HAVERSINE")
        positions = {row.id: row.location for row in demo_positions(
            current, incidents, rows, planned_path(saved, active_matrix), saved.get("now", 0),
        ) if row.id in releasable and not current.anchors[row.id].blocked}
        released = frozenset(releasable[key] for key in positions)
        vehicles = [vehicle.model_copy(update={"location": Point(lat=positions[vehicle.id][0], lon=positions[vehicle.id][1]),
                                               "repositioned_at": scope.now})
                    if vehicle.id in positions else vehicle for vehicle in vehicles]
    snapshot = build_snapshot(scope.now, vehicles, tasks, facilities, rows, incidents, road_matrix, released=released)
    return snapshot, incidents, rows


def snapshot_payload(state: PlanningSnapshot, incidents: list[Incident]) -> tuple[str, dict]:
    body = {
        "provider": state.travel.source, "provider_version": 1, "now": state.now,
        "nodes": [{"id": node.id, "kind": node.kind, "point": node.point.model_dump()}
                  for node in state.travel.nodes],
        "durations": [list(row) for row in state.travel.durations],
        "vehicles": [vehicle.model_dump(mode="json", exclude={"repositioned_at"} if vehicle.repositioned_at is None else None)
                     for vehicle in state.vehicles.values()],
        "tasks": [task.model_dump(mode="json", exclude={field for field in ("pickup_name", "arrival_policy")
                                                        if getattr(task, field) is None})
                  for task in state.tasks.values()],
        "facilities": [facility.model_dump(mode="json") for facility in state.facilities.values()],
        "previous": [row.model_dump(mode="json", exclude={"distance_meters"} if row.distance_meters is None else None)
                     for row in state.previous.values()],
        "anchors": {key: asdict(anchor) for key, anchor in state.anchors.items()},
        "incidents": [incident.model_dump(mode="json") for incident in incidents],
    }
    if state.travel.distances is not None:
        body["distances"] = [list(row) for row in state.travel.distances]
    return sha256(dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest(), body


def persist_snapshot(db: Session, snapshot_id: str, body: dict):
    if db.get(SnapshotRecord, snapshot_id) is None:
        db.add(SnapshotRecord(id=snapshot_id, payload=body))
        db.flush()


def save_plan(db: Session, scope: Scenario, candidate: Candidate, snapshot_id: str,
              *, initial: bool = False) -> Plan:
    plan = Plan(id=uuid4().hex, scenario_id=scope.id, version=1 if initial else None,
                status="ACTIVE" if initial else "DRAFT", snapshot_id=snapshot_id, created_at=timestamp(),
                result=candidate.model_dump(mode="json", exclude={"assignments"}))
    db.add(plan)
    db.flush()
    db.add_all(AssignmentRecord(plan_id=plan.id, task_id=row.task_id, payload=row.model_dump(mode="json"))
               for row in candidate.assignments)
    db.flush()
    return plan


def view_plan(db: Session, plan: Plan) -> PlanView:
    return PlanView(id=plan.id, version=plan.version, status=plan.status, created_at=plan.created_at,
                    snapshot_id=plan.snapshot_id, assignments=assignments(db, plan), **plan.result)


def view_recommendation(db: Session, scope: Scenario, rec: Recommendation) -> RecommendationView:
    decision = db.scalar(select(Decision).where(Decision.recommendation_id == rec.id))
    proposed = db.get(Plan, rec.proposed_plan_id)
    saved = db.get(SnapshotRecord, proposed.snapshot_id)
    incident_ids = [item["id"] for item in saved.payload.get("incidents", [])
                    if item.get("status", "OPEN") == "OPEN"] if saved else []
    status = "STALE" if rec.status == "PROPOSED" and rec.base_revision != scope.revision else rec.status
    return RecommendationView(id=rec.id, base_plan_id=rec.base_plan_id, base_revision=rec.base_revision,
                              status=status, plan=view_plan(db, db.get(Plan, rec.proposed_plan_id)),
                              decision_reason=decision.reason if decision else None,
                              decided_at=decision.created_at if decision else None, incident_ids=incident_ids)


def baseline(state: PlanningSnapshot, rows: list[Assignment]) -> Baseline:
    result, affected = project_existing(state, rows)
    return Baseline(metrics=result, affected=affected,
                    simulated_pickups=sum(task.actual_pickup is not None for task in state.tasks.values()),
                    simulated_arrivals=sum(task.actual_arrival is not None for task in state.tasks.values()))


def view_state(db: Session, scope: Scenario, road_matrix: MatrixProvider | None = None) -> State:
    plan = active_plan(db, scope)
    state, incidents, rows = inputs(db, scope, plan, road_matrix, preserve_active_timing=True)
    return State(scenario_id=scope.id, revision=scope.revision, start_at=scope.start_at, now=scope.now,
                 travel_source=state.travel.source,
                 vehicles=vehicle_views(state, rows), tasks=list(state.tasks.values()),
                 facilities=list(state.facilities.values()), incidents=incidents,
                 active_plan=view_plan(db, plan) if plan else None, baseline=baseline(state, rows))


def vehicle_views(state: PlanningSnapshot, rows: list[Assignment]) -> list[VehicleView]:
    by_vehicle = routes(rows)
    views = []
    for vehicle in state.vehicles.values():
        location = vehicle.location
        status = "AVAILABLE"
        next_available = max(vehicle.available_at, state.now)
        for row in by_vehicle.get(vehicle.id, []):
            task = state.tasks[row.task_id]
            if (row.status == "COMPLETED" or task.actual_arrival is not None) and after_repositioning(vehicle, row):
                location = state.facilities[task.facility_id].location
            if row.status == "IN_PROGRESS":
                status = "EN_ROUTE"
                next_available = max(next_available, row.planned_end)
                if task.actual_arrival is not None:
                    status = "SERVICE"
                elif task.actual_pickup is not None:
                    status = "TRANSPORTING"
                    location = task.pickup
        if vehicle.broken:
            status, next_available = "BROKEN", None
        elif next_available > state.now or any(begin <= state.now < end for begin, end in vehicle.unavailable):
            next_available = max(next_available, *(end for begin, end in vehicle.unavailable
                                                    if begin <= state.now < end), 0)
            if status == "AVAILABLE":
                status = "UNAVAILABLE"
        views.append(VehicleView(**vehicle.model_dump(exclude={"location"}), location=location,
                                 status=status, next_available=next_available))
    return views


def problem(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message})
