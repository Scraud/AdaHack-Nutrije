from sqlalchemy.orm import Session

from app.api.schemas import AssignmentMove, ManualDraft, ManualSlot, PlanView
from app.models import IncidentRecord, Scenario
from app.planning.contracts import Assignment, Candidate, Issue, PlanningSnapshot
from app.planning.snapshot_builder import MatrixProvider, compatible, delivery, pickup, transport_distance
from app.planning.validator import validate_plan
from app.services.metrics import explain, metrics
from app.services.state import (
    active_plan, audit, inputs, persist_snapshot, problem, save_plan, snapshot_payload, timestamp,
)


def move_problem(issue: Issue):
    messages = {
        "BEFORE_EVENT": "Prevoz mora odpeljati po času dogodka in trenutnem času simulacije.",
        "FACILITY_CAPACITY": "Kvota ciljne ustanove je porabljena.",
        "FACILITY_NOT_ACCEPTING": "Ciljna ustanova ne sprejema prevozov.",
        "FROZEN_ASSIGNMENT_CHANGED": "Naloga je zaklenjena ali se že izvaja.",
        "HARD_TIME_WINDOW": "Prevoz se prekriva z drugo nalogo, nedosegljivostjo vozila ali koncem izmene.",
        "INVALID_TRAVEL_TIME": "Do prevzema ni dovolj časa za vožnjo.",
        "NO_COMPATIBLE_VEHICLE": "Vozilo nima ustrezne opreme, vrste prevoza ali kapacitete.",
        "UNREACHABLE_ROUTE": "Cestna povezava ni dosegljiva.",
        "VEHICLE_UNAVAILABLE": "Vozilo ni na voljo za ta prevoz.",
    }
    return problem(409, "MANUAL_MOVE_INVALID",
                   f"{issue.task_id} · {messages.get(issue.code, 'Razporeda v tem terminu ni mogoče potrditi.')}")


def move_rows(snapshot: PlanningSnapshot, rows: list[Assignment], move: AssignmentMove):
    task = snapshot.tasks[move.task_id]
    old = next((row for row in rows if row.task_id == task.id), None)
    loaded = snapshot.travel.seconds(pickup(task.id), delivery(task.id))
    if loaded is None:
        return rows, Issue(code="UNREACHABLE_ROUTE", task_id=task.id)
    take = move.planned_pickup
    arrival = take + task.pickup_service + loaded
    moved = Assignment(task_id=task.id, vehicle_id=move.vehicle_id, planned_departure=take, planned_pickup=take,
                       planned_dropoff=arrival, planned_end=arrival + task.dropoff_service + task.cleaning, deadhead=0)
    updated = {row.task_id: row for row in rows}
    updated[task.id] = moved
    vehicles = {move.vehicle_id, old.vehicle_id} if old else {move.vehicle_id}
    for vehicle_id in vehicles:
        anchor = snapshot.anchors[vehicle_id]
        if anchor.blocked:
            continue
        origin, available = anchor.node, anchor.time
        route = sorted((row for row in updated.values() if row.vehicle_id == vehicle_id and row.status == "PLANNED"),
                       key=lambda row: (row.planned_pickup, row.task_id))
        for row in route:
            if row.task_id not in snapshot.frozen:
                next_task = snapshot.tasks[row.task_id]
                deadhead = snapshot.travel.seconds(origin, pickup(row.task_id))
                loaded = snapshot.travel.seconds(pickup(row.task_id), delivery(row.task_id))
                if row.task_id == task.id and deadhead is None:
                    return rows, Issue(code="UNREACHABLE_ROUTE", task_id=task.id)
                if deadhead is not None and loaded is not None:
                    departure = row.planned_pickup - deadhead
                    if row.task_id != task.id:
                        departure = max(departure, row.planned_departure, available)
                    take = departure + deadhead
                    arrive = take + next_task.pickup_service + loaded
                    end = arrive + next_task.dropoff_service + next_task.cleaning
                    changes = {
                        "planned_departure": departure, "planned_pickup": take, "planned_dropoff": arrive,
                        "planned_end": end, "deadhead": deadhead,
                        "distance_meters": transport_distance(snapshot.travel, origin, row.task_id),
                    }
                    if any(getattr(row, name) != value for name, value in changes.items()):
                        row = row.model_copy(update={**changes, "reroute": None})
                        updated[row.task_id] = row
            origin, available = delivery(row.task_id), row.planned_end
    return list(updated.values()), None


def move_issue(snapshot: PlanningSnapshot, task_id: str, vehicle_id: str) -> Issue | None:
    task = snapshot.tasks[task_id]
    if task_id in snapshot.frozen or task.actual_pickup is not None or task.actual_arrival is not None:
        return Issue(code="FROZEN_ASSIGNMENT_CHANGED", task_id=task_id)
    if snapshot.anchors[vehicle_id].blocked:
        return Issue(code="VEHICLE_UNAVAILABLE", task_id=task_id)
    if not compatible(snapshot.vehicles[vehicle_id], task):
        return Issue(code="NO_COMPATIBLE_VEHICLE", task_id=task_id)
    return None


def checked_move(snapshot, rows, move, earliest, prior_issues):
    if move.planned_pickup < earliest:
        return rows, Issue(code="BEFORE_EVENT", task_id=move.task_id)
    updated, issue = move_rows(snapshot, rows, move)
    if issue:
        return rows, issue
    moved = next(row for row in updated if row.task_id == move.task_id)
    if moved.planned_departure < earliest:
        return rows, Issue(code="BEFORE_EVENT", task_id=move.task_id)
    for issue in validate_plan(snapshot, updated):
        # Removing a predecessor can change the route of a task that still needs a working vehicle.
        pending_transfer = (
            ("VEHICLE_UNAVAILABLE", issue.task_id, issue.vehicle_id) in prior_issues
            and issue.code in ("INVALID_TRAVEL_TIME", "HARD_TIME_WINDOW", "UNREACHABLE_ROUTE")
        )
        if issue.task_id == move.task_id or (
                (issue.code, issue.task_id, issue.vehicle_id) not in prior_issues and not pending_transfer):
            return rows, issue
    return updated, None


def issue_keys(snapshot, rows):
    return {(issue.code, issue.task_id, issue.vehicle_id) for issue in validate_plan(snapshot, rows)}


def replay(snapshot: PlanningSnapshot, rows: list[Assignment], draft: ManualDraft, earliest: int):
    for move in draft.moves:
        if move.task_id not in snapshot.tasks or move.vehicle_id not in snapshot.vehicles:
            raise problem(404, "MANUAL_MOVE_NOT_FOUND", "Izbrana naloga ali vozilo ne obstaja.")
        issue = move_issue(snapshot, move.task_id, move.vehicle_id)
        if issue:
            raise move_problem(issue)
        rows, issue = checked_move(snapshot, rows, move, earliest, issue_keys(snapshot, rows))
        if issue:
            raise move_problem(issue)
    return rows


def context(db: Session, scope: Scenario, incident_id: int, draft: ManualDraft, road_matrix: MatrixProvider | None):
    record = db.get(IncidentRecord, incident_id)
    if record is None or record.scenario_id != scope.id:
        raise problem(404, "INCIDENT_NOT_FOUND", "Dogodek ne obstaja.")
    active = active_plan(db, scope)
    if (not active or active.id != draft.base_plan_id or scope.revision != draft.expected_state_revision
            or record.payload.get("status") == "RESOLVED" or record.payload.get("ended_at") is not None):
        raise problem(409, "STALE_STATE", "Dogodek ali aktivni razpored se je spremenil. Odprite urejanje znova.")
    snapshot, incidents, rows = inputs(db, scope, active, road_matrix, preserve_active_timing=True)
    return record, active, snapshot, incidents, rows, max(scope.now, record.payload["occurred_at"])


def available_slots(db, scope, incident_id, request, road_matrix):
    _, _, snapshot, _, rows, earliest = context(db, scope, incident_id, request, road_matrix)
    rows = replay(snapshot, rows, request, earliest)
    task = snapshot.tasks.get(request.task_id)
    if not task:
        raise problem(404, "MANUAL_MOVE_NOT_FOUND", "Izbrana naloga ne obstaja.")
    loaded = snapshot.travel.seconds(pickup(task.id), delivery(task.id))
    if loaded is None:
        return []
    prior_issues = issue_keys(snapshot, rows)
    last = snapshot.horizon - loaded - task.pickup_service - task.dropoff_service - task.cleaning
    slots = []
    for vehicle_id, anchor in snapshot.anchors.items():
        if move_issue(snapshot, task.id, vehicle_id):
            continue
        first = max(earliest, anchor.time, task.earliest_pickup, 0)
        for take in range((first + 59) // 60 * 60, last + 1, 60):
            move = AssignmentMove(task_id=task.id, vehicle_id=vehicle_id, planned_pickup=take)
            _, issue = checked_move(snapshot, rows, move, earliest, prior_issues)
            if issue:
                continue
            if slots and slots[-1].vehicle_id == vehicle_id and slots[-1].last_pickup == take - 60:
                slots[-1].last_pickup = take
            else:
                slots.append(ManualSlot(vehicle_id=vehicle_id, first_pickup=take, last_pickup=take))
    return slots


def manual_plan(db, scope, incident_id, draft, road_matrix, *, save=False):
    record, active, snapshot, incidents, original, earliest = context(db, scope, incident_id, draft, road_matrix)
    rows = replay(snapshot, original, draft, earliest)
    if not draft.moves or rows == original:
        raise problem(409, "MANUAL_MOVE_INVALID", "Premaknite vsaj eno nalogo.")
    result, changes = metrics(snapshot, rows)
    assigned = {row.task_id for row in rows}
    unassigned = [explain(snapshot, task_id, rows) for task_id in snapshot.tasks if task_id not in assigned]
    issues = validate_plan(snapshot, rows)
    candidate = Candidate(strategy="MANUAL", assignments=rows, metrics=result, changes=changes,
                          blocking=issues, unassigned=unassigned, solver_status="MANUAL",
                          coverage_proven=False, solve_ms=0)
    if save and issues:
        raise move_problem(issues[0])
    if save and record.payload.get("task_id") in {issue.task_id for issue in unassigned}:
        raise problem(409, "MANUAL_MOVE_INVALID", "Naloga dogodka še nima dodeljenega vozila.")
    snapshot_id, payload = snapshot_payload(snapshot, incidents)
    if not save:
        return PlanView(id=f"manual:{active.id}", version=None, status="DRAFT", created_at=timestamp(),
                        snapshot_id=snapshot_id, **candidate.model_dump())
    persist_snapshot(db, snapshot_id, payload)
    plan = save_plan(db, scope, candidate, snapshot_id)
    active.status = "SUPERSEDED"
    db.flush()
    plan.status = "ACTIVE"
    plan.version = active.version + 1
    scope.revision += 1
    record.payload = {**record.payload, "status": "RESOLVED", "resolved_at": timestamp()}
    audit(db, scope, "MANUAL_PLAN", plan_id=plan.id, incident_id=record.id,
          task_ids=[move.task_id for move in draft.moves])
