from collections import Counter
from math import ceil
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas import CreateIncident
from app.models import AssignmentRecord, FacilityRecord, IncidentRecord, Scenario, SnapshotRecord, TaskRecord, VehicleRecord
from app.planning.contracts import Facility, HORIZON, Incident, Node, Point, Reroute, Task, Vehicle
from app.planning.snapshot_builder import MatrixProvider, after_repositioning, routes, travel_snapshot
from app.planning.task_creation import facility_nodes, priority_transport
from app.planning.validator import validate_plan
from app.providers.roads import active_conditions, center_distance, road_network
from app.services.state import active_plan, audit, entities, inputs, problem, timestamp



def add_incident(db: Session, scope: Scenario, request: CreateIncident, road_matrix: MatrixProvider | None = None):
    horizon = max([HORIZON, *(task.planning_horizon or HORIZON for task in entities(db, scope, TaskRecord, Task))])
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
            vehicle.unavailable.append((scope.now, min(horizon, scope.now + (event.duration or 1800))))
        record.payload = vehicle.model_dump(mode="json")
    elif event.type in ("TRAFFIC_DELAY", "ROAD_CLOSURE"):
        roads = road_network()
        if event.road_id is not None and roads.segment(event.road_id) is None:
            raise problem(404, "ROAD_NOT_FOUND", "Odsek ceste ne obstaja.")
        if event.road_id is None and event.location is not None:
            segment = roads.nearest(event.location.lat, event.location.lon)
            event.road_id = segment.id if segment else None
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
        earliest = request.task.earliest_pickup if request.task.earliest_pickup is not None else scope.now
        if scope.now > earliest:
            raise problem(400, "PICKUP_IN_PAST", "Prevzema ni mogoče naročiti v preteklosti.")
        if not 0 <= earliest <= horizon:
            raise problem(400, "INVALID_TASK_TIME", "Prevzem mora biti znotraj delovnega časa.")
        facilities = entities(db, scope, FacilityRecord, Facility)
        incidents = entities(db, scope, IncidentRecord, Incident)
        booked = Counter(task.facility_id for task in entities(db, scope, TaskRecord, Task))
        task_id = f"N{scope.revision + 1:03}"
        nodes = (Node(task_id, "PICKUP", request.task.pickup), *facility_nodes(facilities))
        travel = travel_snapshot(nodes, scope.now, incidents, road_matrix)
        task = priority_transport(task_id, request.task, earliest, facilities, booked, travel)
        if task is None:
            raise problem(400, "NO_REACHABLE_FACILITY", "Od izbranega prevzema ni cestne poti do ustanove.")
        db.add(TaskRecord(id=task.id, scenario_id=scope.id, payload=task.model_dump(mode="json")))
        event.task_id = task.id
        event.priority = task.priority
        event.location = task.pickup
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
    elif event.type in ("TRAFFIC_DELAY", "ROAD_CLOSURE"):
        reroute(db, scope, road_matrix)


def restore_vehicle(db: Session, scope: Scenario, vehicle_id: str):
    record = db.get(VehicleRecord, (vehicle_id, scope.id))
    if record is None:
        raise problem(404, "VEHICLE_NOT_FOUND", "Vozilo ne obstaja.")
    vehicle = Vehicle.model_validate(record.payload)
    if not vehicle.broken:
        return
    vehicle.broken = False
    record.payload = vehicle.model_dump(mode="json")
    resolved_ids = []
    for incident in db.scalars(select(IncidentRecord).where(IncidentRecord.scenario_id == scope.id)):
        if (incident.payload.get("type") == "VEHICLE_BREAKDOWN"
                and incident.payload.get("vehicle_id") == vehicle_id
                and incident.payload.get("status", "OPEN") == "OPEN"):
            incident.payload = {**incident.payload, "status": "RESOLVED", "resolved_at": timestamp()}
            resolved_ids.append(incident.id)
    scope.revision += 1
    audit(db, scope, "VEHICLE_RESTORED", vehicle_id=vehicle_id,
          simulated_time=scope.now, incident_ids=resolved_ids)


def resolve_incident(db: Session, scope: Scenario, incident_id: int, road_matrix: MatrixProvider | None = None):
    record = db.get(IncidentRecord, incident_id)
    if record is None or record.scenario_id != scope.id:
        raise problem(404, "INCIDENT_NOT_FOUND", "Motnja ne obstaja.")
    event = Incident.model_validate(record.payload)
    if event.type == "FLEET_CHANGE":
        if event.status == "RESOLVED":
            raise problem(409, "INCIDENT_ALREADY_ENDED", "Sprememba flote je že zaključena.")
        event.status, event.resolved_at = "RESOLVED", timestamp()
        record.payload = event.model_dump(mode="json")
        scope.revision += 1
        audit(db, scope, "RESOLVE_INCIDENT", incident_id=event.id, simulated_time=scope.now)
        return
    if event.type not in ("TRAFFIC_DELAY", "ROAD_CLOSURE"):
        raise problem(400, "INCIDENT_NOT_RESOLVABLE", "Ročno lahko odstranite samo zastoj, zaporo ali spremembo flote.")
    if event.ended_at is not None or (event.duration is not None and scope.now >= event.occurred_at + event.duration):
        raise problem(409, "INCIDENT_ALREADY_ENDED", "Motnja ni več aktivna.")
    event.ended_at = scope.now
    event.status = "RESOLVED"
    event.resolved_at = timestamp()
    record.payload = event.model_dump(mode="json")
    scope.revision += 1
    audit(db, scope, "RESOLVE_INCIDENT", incident_id=event.id, simulated_time=scope.now)
    reroute(db, scope, road_matrix)


def reroute(db: Session, scope: Scenario, road_matrix: MatrixProvider | None):
    plan = active_plan(db, scope)
    if plan is None:
        return
    state, incidents, assignments = inputs(db, scope, plan, road_matrix, preserve_active_timing=True)
    if not assignments:
        return

    from app.services.tracking import demo_positions

    snapshot_record = db.get(SnapshotRecord, plan.snapshot_id)
    saved = snapshot_record.payload if snapshot_record else {}
    saved_incidents = [Incident.model_validate(item) for item in saved.get("incidents", [])]
    planned_at = saved.get("now", 0)
    roads = road_network()
    previous_conditions = active_conditions(planned_at, saved_incidents)
    previous_path = lambda origin, destination: roads.road_path(
        origin, destination, roads.effects(previous_conditions))
    if saved.get("provider") == "OSRM" and road_matrix is not None:
        previous_path = road_matrix.path
    positions = {vehicle.id: vehicle.location for vehicle in state.vehicles.values()}
    positions.update({row.id: Point(lat=row.location[0], lon=row.location[1]) for row in
                      demo_positions(state, incidents, assignments, previous_path, planned_at,
                                     respect_blocking=False)})
    effects = roads.effects(active_conditions(scope.now, incidents))
    routes_by_vehicle = routes(assignments)
    changed = False

    def distance(path: list[tuple[float, float]]) -> int:
        return ceil(sum(center_distance(a, b) * 111.2 * 1000 for a, b in zip(path, path[1:])))

    for vehicle_id, vehicle_route in routes_by_vehicle.items():
        vehicle = state.vehicles[vehicle_id]
        origin = vehicle.location
        available = max(scope.now, vehicle.available_at)
        for row in vehicle_route:
            task = state.tasks[row.task_id]
            facility = state.facilities[task.facility_id]
            if row.status == "COMPLETED" or task.actual_arrival is not None:
                if after_repositioning(vehicle, row):
                    origin = facility.location
                available = max(available, row.planned_end)
                continue
            if vehicle.broken:
                break

            if row.status == "IN_PROGRESS":
                current = positions[vehicle_id]
                if task.actual_pickup is None:
                    approach = roads.route((current.lat, current.lon), task.pickup, effects)
                    loaded_path = roads.route((task.pickup.lat, task.pickup.lon), facility.location, effects)
                    loaded = state.travel.seconds(f"pickup:{task.id}", f"delivery:{task.id}")
                    if approach is None or loaded_path is None or loaded is None:
                        break
                    pickup_at = max(row.planned_pickup, scope.now + approach[0], task.earliest_pickup)
                    dropoff = pickup_at + task.pickup_service + loaded
                    end = dropoff + task.dropoff_service + task.cleaning
                    updated = row.model_copy(update={
                        "planned_pickup": pickup_at, "planned_dropoff": dropoff, "planned_end": end,
                        "deadhead": approach[0],
                        "distance_meters": distance(approach[1]) + distance(loaded_path[1]),
                        "reroute": Reroute(at=scope.now, start=scope.now, origin=current, leg="PICKUP"),
                    })
                else:
                    start = max(scope.now, row.planned_pickup + task.pickup_service)
                    delivery = roads.route((current.lat, current.lon), facility.location, effects)
                    if delivery is None:
                        break
                    dropoff = max(row.planned_dropoff, start + delivery[0])
                    end = dropoff + task.dropoff_service + task.cleaning
                    updated = row.model_copy(update={
                        "planned_dropoff": dropoff, "planned_end": end,
                        "distance_meters": distance(delivery[1]),
                        "reroute": Reroute(at=scope.now, start=start, origin=current, leg="HOSPITAL"),
                    })
                db.get(AssignmentRecord, (plan.id, row.task_id)).payload = updated.model_dump(mode="json")
                changed = True
                available = updated.planned_end
                origin = facility.location
                continue

            approach = roads.route((origin.lat, origin.lon), task.pickup, effects)
            loaded_path = roads.route((task.pickup.lat, task.pickup.lon), facility.location, effects)
            loaded = state.travel.seconds(f"pickup:{task.id}", f"delivery:{task.id}")
            if approach is None or loaded_path is None or loaded is None:
                break
            departure = max(row.planned_departure, available, scope.now)
            pickup_at = max(row.planned_pickup, departure + approach[0], task.earliest_pickup)
            dropoff = pickup_at + task.pickup_service + loaded
            end = dropoff + task.dropoff_service + task.cleaning
            updated = row.model_copy(update={
                "planned_departure": departure, "planned_pickup": pickup_at,
                "planned_dropoff": dropoff, "planned_end": end, "deadhead": approach[0],
                "distance_meters": distance(approach[1]) + distance(loaded_path[1]),
                "reroute": Reroute(at=scope.now, start=departure, origin=origin, leg="PICKUP"),
            })
            db.get(AssignmentRecord, (plan.id, row.task_id)).payload = updated.model_dump(mode="json")
            changed = True
            available, origin = end, facility.location

    if changed:
        audit(db, scope, "AUTO_DETOUR", simulated_time=scope.now)


def set_demo_clock(db: Session, scope: Scenario, until: int, road_matrix: MatrixProvider | None = None):
    if until == scope.now:
        return
    if until < 0 and scope.now <= 0:
        scope.now = until
        scope.revision += 1
        audit(db, scope, "SET_DEMO_CLOCK", simulated_time=until)
        return
    advance(db, scope, until, road_matrix)


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
    from app.services.scheduling import activate_due
    activate_due(db, scope)
    if record_audit:
        audit(db, scope, "ADVANCE_TIME", simulated_time=until, blocked_tasks=sorted(blocked))
