from sqlalchemy.orm import Session

from app.models import Decision, IncidentRecord, Plan, Recommendation, Scenario, SnapshotRecord, VehicleRecord
from app.planning.snapshot_builder import MatrixProvider
from app.planning.validator import validate_plan
from app.services.state import (
    active_plan, assignments, audit, inputs, problem, snapshot_payload, timestamp, view_recommendation,
)


def decide(db: Session, scope: Scenario, rec_id: str, *, accept: bool, reason: str = "",
           road_matrix: MatrixProvider | None = None):
    rec = db.get(Recommendation, rec_id)
    if rec is None:
        raise problem(404, "RECOMMENDATION_NOT_FOUND", "Predlog ne obstaja.")
    if rec.scenario_id != scope.id:
        raise problem(409, "STALE_RECOMMENDATION", "Predlog je iz prejšnjega scenarija.")
    target_status = "ACCEPTED" if accept else "REJECTED"
    if rec.status == target_status:
        return view_recommendation(db, scope, rec)
    if rec.status != "PROPOSED":
        raise problem(409, "ALREADY_DECIDED", "Odločitev je že zabeležena.")
    if accept:
        active = active_plan(db, scope)
        if not active or active.id != rec.base_plan_id or scope.revision != rec.base_revision:
            raise problem(409, "STALE_RECOMMENDATION", "Predlog je zastarel. Izračunajte nove predloge.")
        candidate = db.get(Plan, rec.proposed_plan_id)
        state, incidents, _ = inputs(db, scope, active, road_matrix)
        if snapshot_payload(state, incidents)[0] != candidate.snapshot_id:
            raise problem(409, "STALE_RECOMMENDATION", "Vhodni podatki so se spremenili.")
        if candidate.result["blocking"] or validate_plan(state, assignments(db, candidate)):
            raise problem(409, "BLOCKED_PLAN", "Pred potrditvijo je potrebna ročna koordinacija.")
        for task_id in candidate.result.get("released_task_ids", []):
            vehicle = state.vehicles[state.previous[task_id].vehicle_id]
            db.get(VehicleRecord, (vehicle.id, scope.id)).payload = vehicle.model_dump(mode="json")
        active.status = "SUPERSEDED"
        db.flush()
        candidate.status = "ACTIVE"
        candidate.version = active.version + 1
        scope.revision += 1
        saved = db.get(SnapshotRecord, candidate.snapshot_id)
        for incident in saved.payload.get("incidents", []) if saved else []:
            record = db.get(IncidentRecord, incident["id"])
            if record and record.scenario_id == scope.id and record.payload.get("status", "OPEN") == "OPEN":
                record.payload = {**record.payload, "status": "RESOLVED",
                                  "selected_recommendation_id": rec.id, "resolved_at": timestamp()}
    rec.status = target_status
    db.add(Decision(recommendation_id=rec.id, action=target_status, reason=reason,
                    actor="dispatcher", created_at=timestamp()))
    audit(db, scope, target_status, recommendation_id=rec.id, plan_id=rec.proposed_plan_id)
    return view_recommendation(db, scope, rec)
