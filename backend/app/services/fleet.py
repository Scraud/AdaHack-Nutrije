import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas import NewVehicle, VehicleSettings
from app.models import IncidentRecord, Scenario, VehicleRecord
from app.planning.contracts import Incident, Vehicle
from app.services.state import active_plan, assignments, audit, problem

EQUIPMENT_NAMES = {"STRETCHER": "nosila", "WHEELCHAIR": "voziček", "OXYGEN": "kisik", "VENTILATOR": "prenosni respirator"}


def _settings(request: VehicleSettings) -> dict:
    return {"capacity": request.capacity, "equipment": list(dict.fromkeys(request.equipment)),
            "task_types": list(dict.fromkeys(request.task_types))}


def _describe(settings: dict) -> str:
    equipment = ", ".join(EQUIPMENT_NAMES[item] for item in settings["equipment"]) or "brez opreme"
    return f"{equipment}; kapaciteta {settings['capacity']}"


def _vehicle(db: Session, scope: Scenario, vehicle_id: str) -> tuple[VehicleRecord, Vehicle]:
    record = db.get(VehicleRecord, (vehicle_id, scope.id))
    vehicle = Vehicle.model_validate(record.payload) if record else None
    if vehicle is None or vehicle.retired:
        raise problem(404, "VEHICLE_NOT_FOUND", "Vozilo ne obstaja.")
    return record, vehicle


def _record_change(db: Session, scope: Scenario, vehicle_id: str, description: str):
    """Fleet changes become incidents so the dispatcher can replan and decide in the usual flow."""
    event = Incident(type="FLEET_CHANGE", occurred_at=scope.now, vehicle_id=vehicle_id, description=description)
    record = IncidentRecord(scenario_id=scope.id, payload=event.model_dump(mode="json"))
    db.add(record)
    db.flush()
    record.payload = {**record.payload, "id": record.id}
    scope.revision += 1


def add_vehicle(db: Session, scope: Scenario, request: NewVehicle) -> str:
    ids = db.scalars(select(VehicleRecord.id).where(VehicleRecord.scenario_id == scope.id))
    numbers = [int(match.group(1)) for value in ids if (match := re.fullmatch(r"V(\d+)", value))]
    settings = _settings(request)
    vehicle = Vehicle(id=f"V{max(numbers, default=0) + 1}", location=request.location,
                      available_at=max(0, scope.now), **settings)
    db.add(VehicleRecord(id=vehicle.id, scenario_id=scope.id, payload=vehicle.model_dump(mode="json")))
    _record_change(db, scope, vehicle.id, f"{vehicle.id} dodano v floto ({_describe(settings)}).")
    audit(db, scope, "VEHICLE_ADDED", vehicle_id=vehicle.id, simulated_time=scope.now, **settings)
    return vehicle.id


def update_vehicle(db: Session, scope: Scenario, vehicle_id: str, request: VehicleSettings):
    record, vehicle = _vehicle(db, scope, vehicle_id)
    settings = _settings(request)
    record.payload = vehicle.model_copy(update=settings).model_dump(mode="json")
    _record_change(db, scope, vehicle_id, f"{vehicle_id}: nova oprema ({_describe(settings)}).")
    audit(db, scope, "VEHICLE_UPDATED", vehicle_id=vehicle_id, simulated_time=scope.now, **settings)


def remove_vehicle(db: Session, scope: Scenario, vehicle_id: str):
    record, vehicle = _vehicle(db, scope, vehicle_id)
    if any(row.vehicle_id == vehicle_id and row.status == "IN_PROGRESS" for row in assignments(db, active_plan(db, scope))):
        raise problem(409, "VEHICLE_IN_USE", "Vozilo je na poti ali prevaža pacienta. Odstranite ga po zaključku naloge.")
    # Planned work of a retired vehicle shows up as affected, like after a breakdown, and is moved by a replan.
    record.payload = vehicle.model_copy(update={"retired": True}).model_dump(mode="json")
    _record_change(db, scope, vehicle_id, f"{vehicle_id} odstranjeno iz flote.")
    audit(db, scope, "VEHICLE_REMOVED", vehicle_id=vehicle_id, simulated_time=scope.now)
