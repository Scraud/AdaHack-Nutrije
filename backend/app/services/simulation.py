from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.api.schemas import CreateIncident
from app.models import AssignmentRecord, FacilityRecord, IncidentRecord, Scenario, TaskRecord, VehicleRecord
from app.planning.contracts import Facility, HORIZON, Incident, Task, Vehicle
from app.planning.snapshot_builder import MatrixProvider, routes
from app.planning.validator import validate_plan
from app.providers.roads import center_distance, road_network
from app.services.state import active_plan, audit, inputs, problem


def add_incident(db: Session, scope: Scenario, request: CreateIncident, road_matrix: MatrixProvider | None = None):
    event = Incident(occurred_at=scope.now, **request.model_dump(
        exclude={"task"}, exclude_none=True,
    ))
    if event.type in ("VEHICLE_BREAKDOWN", "VEHICLE_UNAVAILABLE"):
        record = db.get(VehicleRecord, (event.vehicle_id or "", scope.id))
        if not record:
            raise problem(404, "VEHICLE_NOT_FOUND", "Vozilo ne obstaja.")
        vehicle = Vehicle.model_validate(record.payload)
        if event.type == "VEHICLE_BREAKDOWN":
            if vehicle.broken:
                raise problem(409, "VEHICLE_ALREADY_BROKEN", "Okvara vozila je že zabeležena.")
            vehicle.broken = True
        else:
            vehicle.unavailable.append((scope.now, min(HORIZON, scope.now + (event.duration or 1800))))
        record.payload = vehicle.model_dump(mode="json")
    elif event.type in ("TRAFFIC_DELAY", "ROAD_CLOSURE"):
        roads = road_network()
        if event.road_id not in roads.segments and event.road_id is not None:
            raise problem(404, "ROAD_NOT_FOUND", "Odsek ceste ne obstaja.")
        if event.road_id is None and event.location is not None:
            # Older clients can still send a point. Resolve it to the closest configured road section.
            point = (event.location.lat, event.location.lon)
            event.road_id = min(roads.segments, key=lambda key: min(
                center_distance(point, roads.points[node]) for node in roads.segments[key].vertices))
        if event.road_id is None:
            raise problem(400, "ROAD_REQUIRED", "Izberite odsek ceste.")
    elif event.type == "WEATHER_DELAY":
        if event.location is None:
            raise problem(400, "LOCATION_REQUIRED", "Za motnjo izberite območje.")
    elif event.type == "FACILITY_CAPACITY_CHANGE":
        record = db.get(FacilityRecord, (event.facility_id or "", scope.id))
        if record is None or event.quota is None:
            raise problem(400, "FACILITY_QUOTA_REQUIRED", "Izberite ustanovo in določite kvoto.")
        facility = Facility.model_validate(record.payload)
        facility.quota = event.quota
        record.payload = facility.model_dump(mode="json")
    elif event.type == "NEW_TASK":
        if request.task is None:
            raise problem(400, "TASK_REQUIRED", "Vnesite podatke nove naloge.")
        if not db.get(FacilityRecord, (request.task.facility_id, scope.id)):
            raise problem(404, "FACILITY_NOT_FOUND", "Ustanova ne obstaja.")
        if scope.now > request.task.earliest_pickup:
            raise problem(400, "PICKUP_IN_PAST", "Prevzema ni mogoče naročiti v preteklosti.")
        task_id = f"N{scope.revision + 1:03}"
        try:
            task = Task(id=task_id, type="PRIORITY_TRANSPORT", **request.task.model_dump())
        except ValidationError as exc:
            raise problem(400, "INVALID_TASK_TIME", exc.errors()[0]["msg"]) from exc
        db.add(TaskRecord(id=task.id, scenario_id=scope.id, payload=task.model_dump(mode="json")))
        event.task_id = task.id
    record = IncidentRecord(scenario_id=scope.id, payload=event.model_dump(mode="json"))
    db.add(record)
    db.flush()
    event.id = record.id
    record.payload = event.model_dump(mode="json")
    scope.revision += 1
    audit(db, scope, event.type, incident_id=event.id, simulated_time=scope.now)
    if event.type == "VEHICLE_BREAKDOWN":
        snapshot, _, _ = inputs(db, scope, active_plan(db, scope), road_matrix, preserve_active_timing=True)
        for issue in snapshot.blocking:
            if issue.vehicle_id == event.vehicle_id and issue.code == "MANUAL_COORDINATION":
                audit(db, scope, issue.code, incident_id=event.id, task_id=issue.task_id)


def advance(db: Session, scope: Scenario, until: int, road_matrix: MatrixProvider | None = None, *,
            record_audit: bool = True):
    if until <= scope.now:
        raise problem(400, "TIME_MUST_ADVANCE", "Simulirani čas se lahko premika samo naprej.")
    plan = active_plan(db, scope)
    snapshot, _, assignments = inputs(db, scope, plan, road_matrix, preserve_active_timing=True)
    blocked = {issue.task_id for issue in validate_plan(snapshot, assignments)}
    for route in routes(assignments).values():
        route_blocked = False
        for row in route:
            if row.status == "COMPLETED" or row.planned_departure > until:
                continue
            route_blocked |= row.task_id in blocked
            if route_blocked:
                continue
            task = snapshot.tasks[row.task_id]
            task_record = db.get(TaskRecord, (task.id, scope.id))
            if row.planned_pickup <= until:
                task.actual_pickup = row.planned_pickup
            if row.planned_dropoff <= until:
                task.actual_arrival = row.planned_dropoff
            task_record.payload = task.model_dump(mode="json")
            row.status = "COMPLETED" if row.planned_end <= until else "IN_PROGRESS"
            db.get(AssignmentRecord, (plan.id, row.task_id)).payload = row.model_dump(mode="json")
    scope.now = until
    scope.revision += 1
    if record_audit:
        audit(db, scope, "ADVANCE_TIME", simulated_time=until, blocked_tasks=sorted(blocked))
