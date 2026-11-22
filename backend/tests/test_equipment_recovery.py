from fastapi.testclient import TestClient

from app.db import Database
from app.main import create_app
from app.models import TaskRecord, VehicleRecord
from app.planning.contracts import Point, Task, Vehicle
from app.planning.cp_sat_planner import CpSatPlanner
from app.planning.snapshot_builder import build_snapshot
from app.planning.validator import validate_plan
from app.seed.scenario import demo_data
from tests.test_dispatch import post, replan


def test_recovery_uses_breakdown_location_and_cargo_without_requiring_it_on_the_collector(tmp_path):
    path = tmp_path / "recovery.sqlite"
    with TestClient(create_app(path)) as client:
        state = client.get("/api/state").json()
        # Isolate equipment transport: the collector starts without any medical equipment.
        with Database(path).session(write=True) as db:
            for task in db.query(TaskRecord).filter_by(scenario_id=state["scenario_id"]):
                db.delete(task)
            for record in db.query(VehicleRecord).filter_by(scenario_id=state["scenario_id"]):
                record.payload = {**record.payload, "equipment": ["OXYGEN"] if record.id == "V3" else [],
                                  "retired": record.id not in ("V2", "V3")}
        initial = post(client, "plans/generate")
        broken = post(client, "incidents", {"type": "VEHICLE_BREAKDOWN", "vehicle_id": "V3"})
        location = broken["incidents"][-1]["location"]
        post(client, "incidents", {"type": "FACILITY_CAPACITY_CHANGE", "facility_id": "F1", "quota": 0})
        created = post(client, "vehicles/V3/equipment-recovery", {
            "priority": "P1", "equipment": ["OXYGEN"], "facility_id": "F1"})
        task = next(t for t in created["tasks"] if t["type"] == "EQUIPMENT_DELIVERY")
        assert task["pickup"] == location
        assert task["equipment"] == [] and task["cargo_equipment"] == ["OXYGEN"]
        assert task["source_vehicle_id"] == "V3" and task["passenger_count"] == 0
        assert (task["pickup_service"], task["dropoff_service"], task["cleaning"]) == (120, 120, 0)
        assert created["active_plan"]["id"] == initial["active_plan"]["id"]
        assert created["incidents"][-1]["source"] == "EQUIPMENT_RECOVERY"
        items = replan(client, created)
        chosen = next(item for item in items if any(a["task_id"] == task["id"] for a in item["plan"]["assignments"]))
        assignment = next(a for a in chosen["plan"]["assignments"] if a["task_id"] == task["id"])
        assert assignment["vehicle_id"] == "V2"
        assert client.get("/api/state").json()["active_plan"]["id"] == initial["active_plan"]["id"]
        post(client, f"recommendations/{chosen['id']}/accept", {})
        delivered = post(client, "demo/advance-time", {"to": assignment["planned_end"]})
        saved = next(t for t in delivered["tasks"] if t["id"] == task["id"])
        assert saved["actual_pickup"] is not None and saved["actual_arrival"] is not None
        assert next(v for v in delivered["vehicles"] if v["id"] == "V3")["broken"]
    with TestClient(create_app(path)) as client:
        assert any(t["id"] == task["id"] for t in client.get("/api/state").json()["tasks"])


def test_recovery_rejects_invalid_source_missing_equipment_and_duplicate_requests(tmp_path):
    with TestClient(create_app(tmp_path / "validation.sqlite")) as client:
        payload = {"priority": "P2", "equipment": ["OXYGEN"], "facility_id": "F1"}
        assert client.post("/api/vehicles/missing/equipment-recovery", json=payload).status_code == 404
        assert client.post("/api/vehicles/V3/equipment-recovery", json=payload).status_code == 409
        post(client, "incidents", {"type": "VEHICLE_BREAKDOWN", "vehicle_id": "V3"})
        assert client.post("/api/vehicles/V3/equipment-recovery", json={**payload, "equipment": []}).status_code == 422
        assert client.post("/api/vehicles/V3/equipment-recovery", json={**payload, "equipment": ["WHEELCHAIR"]}).status_code == 400
        assert client.post("/api/vehicles/V3/equipment-recovery", json={**payload, "facility_id": "missing"}).status_code == 404
        post(client, "vehicles/V3/equipment-recovery", payload)
        duplicate = client.post("/api/vehicles/V3/equipment-recovery", json=payload)
        assert duplicate.status_code == 409 and duplicate.json()["detail"]["code"] == "EQUIPMENT_ALREADY_REQUESTED"
        assert len([t for t in client.get("/api/state").json()["tasks"] if t["type"] == "EQUIPMENT_DELIVERY"]) == 1
        post(client, "vehicles/V3/restore")
        assert client.post("/api/vehicles/V3/equipment-recovery", json=payload).status_code == 409


def test_breakdown_saves_the_actual_road_position_not_the_vehicle_base(tmp_path):
    with TestClient(create_app(tmp_path / "position.sqlite")) as client:
        post(client, "plans/generate")
        found = None
        for instant in [600, 1200, 1500]:
            post(client, "demo/advance-time", {"to": instant})
            found = next((v for v in client.get("/api/tracking").json()["vehicles"] if v["status"] == "TO_PICKUP"), None)
            if found:
                break
        assert found, "The fixture needs an approaching vehicle."
        state = post(client, "incidents", {"type": "VEHICLE_BREAKDOWN", "vehicle_id": found["id"]})
        assert state["incidents"][-1]["location"] == {"lat": found["location"][0], "lon": found["location"][1]}


def test_urgent_equipment_is_picked_up_before_a_nearer_low_priority_delivery():
    _, facilities, _ = demo_data()
    vehicle = Vehicle(id="V1", location=Point(lat=46.046, lon=14.494), capacity=1, equipment=[],
                      task_types=["EQUIPMENT_DELIVERY"])
    def cargo(task_id, priority, lat, lon):
        return Task(id=task_id, type="EQUIPMENT_DELIVERY", priority=priority, pickup=Point(lat=lat, lon=lon),
                    facility_id="F1", passenger_count=0, equipment=[], cargo_equipment=["OXYGEN"],
                    earliest_pickup=600, pickup_service=120, dropoff_service=120, cleaning=0)
    state = build_snapshot(0, [vehicle], [cargo("NEAR", "P3", 46.047, 14.495), cargo("URGENT", "P1", 46.075, 14.53)], facilities, [], [])
    plan = CpSatPlanner().alternatives(state)[0].plan
    assert [row.task_id for row in sorted(plan.assignments, key=lambda row: row.planned_pickup)] == ["URGENT", "NEAR"]
    assert validate_plan(state, plan.assignments) == []
