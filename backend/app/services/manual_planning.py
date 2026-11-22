from sqlalchemy.orm import Session

from app.api.schemas import AssignmentMove, Replan
from app.models import IncidentRecord, Scenario
from app.planning.contracts import Assignment, Candidate, Issue, PlanningSnapshot
from app.planning.snapshot_builder import MatrixProvider, compatible, delivery, pickup, transport_distance
from app.planning.validator import validate_plan
from app.services.metrics import explain, metrics, predecessors
from app.services.state import active_plan, audit, inputs, persist_snapshot, problem, save_plan, snapshot_payload, timestamp


MOVE_ISSUES = {
    "FACILITY_CAPACITY": "Kvota ciljne ustanove je porabljena.",
    "FACILITY_NOT_ACCEPTING": "Ciljna ustanova ne sprejema prevozov.",
    "FROZEN_ASSIGNMENT_CHANGED": "Dodelitev je zaklenjena ali se že izvaja.",
    "HARD_TIME_WINDOW": "Termin se prekriva z drugim prevozom ali je zunaj dovoljenega časovnega okna.",
    "INVALID_TRAVEL_TIME": "Do prevzema ni dovolj časa za vožnjo.",
    "NO_COMPATIBLE_VEHICLE": "Vozilo nima ustrezne opreme, vrste prevoza ali kapacitete.",
    "UNREACHABLE_ROUTE": "Cestna povezava ni dosegljiva.",
    "VEHICLE_UNAVAILABLE": "Vozilo ni na voljo za ta prevoz.",
}


def invalid_move(issue: Issue):
    return problem(409, "MANUAL_MOVE_INVALID",
                   f"{issue.task_id} · {MOVE_ISSUES.get(issue.code, 'Razporeda v tem terminu ni mogoče potrditi.')}")


def reschedule_approaches(snapshot: PlanningSnapshot, rows: list[Assignment], moved: Assignment,
                          old: Assignment | None, *, cascade: bool = False) -> list[Assignment]:
    previous = predecessors([row for row in rows if row.status == "PLANNED"])
    updated = {row.task_id: row for row in rows}
    updated[moved.task_id] = moved
    vehicles = {moved.vehicle_id}
    if old:
        vehicles.add(old.vehicle_id)
    for vehicle_id in vehicles:
        anchor = snapshot.anchors[vehicle_id]
        if cascade and anchor.blocked:
            continue
        origin, available = anchor.node, anchor.time
        predecessor = None
        route = sorted((row for row in updated.values()
                        if row.vehicle_id == vehicle_id and row.status == "PLANNED"),
                       key=lambda row: (row.planned_pickup, row.task_id))
        for row in route:
            if cascade or row.task_id == moved.task_id or previous.get(row.task_id) != predecessor:
                deadhead = snapshot.travel.seconds(origin, pickup(row.task_id))
                if deadhead is None:
                    raise invalid_move(Issue(code="UNREACHABLE_ROUTE", task_id=row.task_id))
                distance = transport_distance(snapshot.travel, origin, row.task_id)
                changes = {"distance_meters": distance}
                if not row.is_locked:
                    changes.update(planned_departure=row.planned_pickup - deadhead, deadhead=deadhead)
                if cascade and not row.is_locked and row.task_id != moved.task_id:
                    shift = max(0, available - changes["planned_departure"])
                    task = snapshot.tasks[row.task_id]
                    pickup_at = row.planned_pickup + shift
                    loaded = snapshot.travel.seconds(pickup(row.task_id), delivery(row.task_id))
                    if loaded is not None:
                        dropoff = pickup_at + task.pickup_service + loaded
                        changes.update(planned_departure=changes["planned_departure"] + shift,
                                       planned_pickup=pickup_at, planned_dropoff=dropoff,
                                       planned_end=dropoff + task.dropoff_service + task.cleaning,
                                       reroute=None)
                updated[row.task_id] = row.model_copy(update=changes)
            available = updated[row.task_id].planned_end
            predecessor, origin = row.task_id, delivery(row.task_id)
    return list(updated.values())


def manual_snapshot(db: Session, scope: Scenario, request: Replan, road_matrix: MatrixProvider | None):
    active = active_plan(db, scope)
    if not active or active.id != request.base_plan_id or scope.revision != request.expected_state_revision:
        raise problem(409, "STALE_STATE", "Aktivni razpored se je spremenil. Odprite premik znova.")

    return active, *inputs(db, scope, active, road_matrix, preserve_active_timing=True)


def apply_move(snapshot: PlanningSnapshot, rows: list[Assignment], request: AssignmentMove, *, cascade: bool):
    task = snapshot.tasks.get(request.task_id)
    vehicle = snapshot.vehicles.get(request.vehicle_id)
    if not task or not vehicle:
        raise problem(404, "MANUAL_MOVE_NOT_FOUND", "Izbrana naloga ali vozilo ne obstaja.")
    if task.id in snapshot.frozen or task.actual_pickup is not None or task.actual_arrival is not None:
        raise invalid_move(Issue(code="FROZEN_ASSIGNMENT_CHANGED", task_id=task.id))
    if snapshot.anchors[vehicle.id].blocked:
        raise invalid_move(Issue(code="VEHICLE_UNAVAILABLE", task_id=task.id))
    if not compatible(vehicle, task):
        raise invalid_move(Issue(code="NO_COMPATIBLE_VEHICLE", task_id=task.id))

    old = next((row for row in rows if row.task_id == task.id), None)
    loaded = snapshot.travel.seconds(pickup(task.id), delivery(task.id))
    if loaded is None:
        raise invalid_move(Issue(code="UNREACHABLE_ROUTE", task_id=task.id))
    arrival = request.planned_pickup + task.pickup_service + loaded
    moved = Assignment(task_id=task.id, vehicle_id=vehicle.id, planned_departure=request.planned_pickup,
                       planned_pickup=request.planned_pickup, planned_dropoff=arrival,
                       planned_end=arrival + task.dropoff_service + task.cleaning, deadhead=0)
    return reschedule_approaches(snapshot, rows, moved, old, cascade=cascade)


def evaluate_manual(db: Session, scope: Scenario, request: Replan, moves: list[AssignmentMove],
                    road_matrix: MatrixProvider | None, *, cascade: bool = False):
    active, snapshot, incidents, rows = manual_snapshot(db, scope, request, road_matrix)
    updated = rows
    for move in moves:
        updated = apply_move(snapshot, updated, move, cascade=cascade)
    issues = validate_plan(snapshot, updated)
    prior_issues = {(issue.task_id, issue.vehicle_id, issue.code) for issue in validate_plan(snapshot, rows)}
    for issue in issues:
        if not cascade and (issue.task_id == moves[0].task_id or (issue.task_id, issue.vehicle_id, issue.code) not in prior_issues):
            raise invalid_move(issue)

    result, changes = metrics(snapshot, updated)
    assigned = {row.task_id for row in updated}
    candidate = Candidate(strategy="MANUAL", assignments=updated, metrics=result, changes=changes,
                          blocking=issues, unassigned=[explain(snapshot, key) for key in snapshot.tasks if key not in assigned],
                          solver_status="MANUAL", coverage_proven=False, solve_ms=0)
    snapshot_id, payload = snapshot_payload(snapshot, incidents)
    return active, candidate, snapshot_id, payload, updated != rows


def save_manual(db: Session, scope: Scenario, evaluation, incident: IncidentRecord | None = None):
    active, candidate, snapshot_id, payload, changed = evaluation
    if incident is not None and candidate.blocking:
        raise invalid_move(candidate.blocking[0])
    if not changed:
        return
    persist_snapshot(db, snapshot_id, payload)
    plan = save_plan(db, scope, candidate, snapshot_id)
    active.status = "SUPERSEDED"
    db.flush()
    plan.status = "ACTIVE"
    plan.version = active.version + 1
    scope.revision += 1
    if incident is not None:
        incident.payload = {**incident.payload, "status": "RESOLVED", "resolved_at": timestamp()}
    audit(db, scope, "MANUAL_PLAN", plan_id=plan.id, incident_id=incident.id if incident else None,
          task_ids=[change.task_id for change in candidate.changes])
