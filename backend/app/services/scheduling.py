from datetime import datetime
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas import CreateScheduledTask, ScheduledTaskView
from app.models import FacilityRecord, IncidentRecord, Scenario, ScheduledTaskRecord, TaskRecord
from app.planning.contracts import Incident, Task
from app.services.state import audit, problem

PLANNING_WINDOW = 24 * 3600


def future_tasks(db: Session, scope: Scenario) -> list[ScheduledTaskView]:
    rows = db.scalars(select(ScheduledTaskRecord).where(ScheduledTaskRecord.scenario_id == scope.id))
    return sorted((ScheduledTaskView.model_validate(row.payload) for row in rows
                   if not row.payload.get("activated")), key=lambda item: item.scheduled_at)


def activate_due(db: Session, scope: Scenario):
    for row in db.scalars(select(ScheduledTaskRecord).where(ScheduledTaskRecord.scenario_id == scope.id)):
        task = Task.model_validate(row.payload["task"])
        if row.payload.get("activated") or task.earliest_pickup > scope.now + PLANNING_WINDOW:
            continue
        db.add(TaskRecord(id=task.id, scenario_id=scope.id, payload=task.model_dump(mode="json")))
        event = Incident(type="NEW_TASK", task_id=task.id, occurred_at=scope.now, location=task.pickup,
                         priority=task.priority, description=row.payload["description"] or
                         f"Nova prevozna naloga: {task.pickup_name}.", source="SCHEDULED_TASK")
        record = IncidentRecord(scenario_id=scope.id, payload=event.model_dump(mode="json"))
        db.add(record)
        db.flush()
        event.id = record.id
        record.payload = event.model_dump(mode="json")
        row.payload = {**row.payload, "activated": True}
        scope.revision += 1
        audit(db, scope, "TASK_ENTERED_PLANNING_WINDOW", task_id=task.id, incident_id=event.id)


def create_scheduled_task(db: Session, scope: Scenario, request: CreateScheduledTask):
    seconds = round((request.scheduled_at - datetime.fromisoformat(scope.start_at)).total_seconds())
    if seconds < max(0, scope.now):
        raise problem(400, "PICKUP_IN_PAST", "Prevzem mora biti v prihodnosti demo ure.")
    if not db.get(FacilityRecord, (request.facility_id, scope.id)):
        raise problem(404, "FACILITY_NOT_FOUND", "Izberite obstoječo ciljno ustanovo.")
    task_id = f"S{uuid4().hex[:12]}"
    task = Task(id=task_id, type="PLANNED_TRANSPORT", priority=request.priority, pickup=request.pickup,
                pickup_name=request.pickup_name, facility_id=request.facility_id,
                passenger_count=request.passenger_count, equipment=request.equipment,
                earliest_pickup=seconds, latest_pickup=seconds + 1800,
                planning_horizon=seconds + 7200 + 360)
    entry = ScheduledTaskView(id=task_id, scheduled_at=request.scheduled_at, task=task,
                              description=request.description)
    db.add(ScheduledTaskRecord(id=task_id, scenario_id=scope.id,
                              payload={**entry.model_dump(mode="json"), "activated": False}))
    # Future-only records do not invalidate the current plan or its existing proposals.
    audit(db, scope, "CREATE_SCHEDULED_TASK", task_id=task_id, scheduled_at=request.scheduled_at.isoformat())
    db.flush()
    activate_due(db, scope)
