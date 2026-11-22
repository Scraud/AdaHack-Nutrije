from uuid import uuid4

from sqlalchemy.orm import Session

from app.api.schemas import CreateEquipmentRecovery
from app.models import FacilityRecord, IncidentRecord, Scenario, TaskRecord, VehicleRecord
from app.planning.contracts import Facility, HORIZON, Incident, Point, Task, Vehicle
from app.planning.snapshot_builder import MatrixProvider
from app.services.state import active_plan, audit, entities, inputs, problem


def vehicle_position(db: Session, scope: Scenario, vehicle_id: str,
                     road_matrix: MatrixProvider | None = None) -> Point:
    """Use the same simulated road position as the map, including a stopped vehicle."""
    from app.models import SnapshotRecord
    from app.services.tracking import demo_positions, planned_path

    plan = active_plan(db, scope)
    state, incidents, rows = inputs(db, scope, plan, road_matrix, preserve_active_timing=True)
    saved = db.get(SnapshotRecord, plan.snapshot_id).payload if plan else {}
    positions = demo_positions(state, incidents, rows, planned_path(saved, road_matrix), saved.get("now", 0))
    position = next(row.location for row in positions if row.id == vehicle_id)
    return Point(lat=position[0], lon=position[1])


def create_equipment_recovery(db: Session, scope: Scenario, vehicle_id: str,
                              request: CreateEquipmentRecovery, road_matrix: MatrixProvider | None = None, *,
                              attach_to_breakdown: bool = False):
    record = db.get(VehicleRecord, (vehicle_id, scope.id))
    if record is None or record.payload.get("retired"):
        raise problem(404, "VEHICLE_NOT_FOUND", "Vozilo ne obstaja.")
    vehicle = Vehicle.model_validate(record.payload)
    if not vehicle.broken:
        raise problem(409, "VEHICLE_NOT_BROKEN", "Prevzem opreme je na voljo pri pokvarjenem vozilu.")
    cargo = sorted(set(request.equipment))
    if not set(cargo).issubset(vehicle.equipment):
        raise problem(400, "EQUIPMENT_NOT_ON_VEHICLE", "Izberite opremo pokvarjenega vozila.")
    facility_record = db.get(FacilityRecord, (request.facility_id, scope.id))
    if facility_record is None:
        raise problem(404, "FACILITY_NOT_FOUND", "Izberite obstoječo ciljno ustanovo.")
    facility = Facility.model_validate(facility_record.payload)
    breakdown = max((event for event in entities(db, scope, IncidentRecord, Incident)
                     if event.type == "VEHICLE_BREAKDOWN" and event.vehicle_id == vehicle_id),
                    key=lambda event: event.id, default=None)
    if breakdown is None:
        raise problem(409, "BREAKDOWN_REQUIRED", "Najprej zabeležite okvaro vozila.")
    tasks = entities(db, scope, TaskRecord, Task)
    reserved = {item for task in tasks if task.source_incident_id == breakdown.id for item in task.cargo_equipment}
    if reserved.intersection(cargo):
        raise problem(409, "EQUIPMENT_ALREADY_REQUESTED", "Za izbrano opremo te okvare že obstaja naloga prevzema.")
    location = breakdown.location or vehicle_position(db, scope, vehicle_id, road_matrix)
    task = Task(id=f"E{uuid4().hex[:12]}", type="EQUIPMENT_DELIVERY", priority=request.priority,
                pickup=location, pickup_name=f"Prevzem opreme · {vehicle_id}", facility_id=facility.id,
                passenger_count=0, equipment=[], cargo_equipment=cargo,
                source_vehicle_id=vehicle_id, source_incident_id=breakdown.id,
                earliest_pickup=max(0, scope.now), pickup_service=120, dropoff_service=120, cleaning=0,
                planning_horizon=max([HORIZON, *(t.planning_horizon or HORIZON for t in tasks)]))
    db.add(TaskRecord(id=task.id, scenario_id=scope.id, payload=task.model_dump(mode="json")))
    if attach_to_breakdown:
        incident_record = db.get(IncidentRecord, breakdown.id)
        incident_record.payload = {**incident_record.payload, "task_id": task.id}
        incident_id = breakdown.id
    else:
        event = Incident(type="NEW_TASK", source="EQUIPMENT_RECOVERY", task_id=task.id, location=location,
                         occurred_at=scope.now, priority=request.priority,
                         description=request.description or f"Prevzem opreme iz {vehicle_id} → {facility.name}.")
        incident_record = IncidentRecord(scenario_id=scope.id, payload=event.model_dump(mode="json"))
        db.add(incident_record)
        db.flush()
        event.id = incident_record.id
        incident_record.payload = event.model_dump(mode="json")
        incident_id = event.id
    scope.revision += 1
    audit(db, scope, "EQUIPMENT_RECOVERY_REQUESTED", vehicle_id=vehicle_id, task_id=task.id,
          equipment=cargo, incident_id=incident_id, source_incident_id=breakdown.id)
