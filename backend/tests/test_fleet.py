import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services.advisor import Advisor
from tests.test_dispatch import post, replan

OXYGEN_VAN = {"capacity": 2, "equipment": ["OXYGEN", "STRETCHER", "OXYGEN"],
              "task_types": ["PLANNED_TRANSPORT", "PRIORITY_TRANSPORT"],
              "location": {"lat": 46.051, "lon": 14.566}}


@pytest.fixture
def demo(tmp_path):
    with TestClient(create_app(tmp_path / "fleet.sqlite", advisor=Advisor(None, "x"))) as client:
        yield client


def waiting(state):
    tasks = {task["id"]: task for task in state["tasks"]}
    return sum(row["planned_pickup"] - tasks[row["task_id"]]["earliest_pickup"]
               for row in state["active_plan"]["assignments"])


def test_added_vehicle_is_used_and_reduces_waiting(demo):
    before = post(demo, "plans/generate")
    post(demo, "demo/reset")
    state = post(demo, "vehicles", OXYGEN_VAN)
    added = next(v for v in state["vehicles"] if v["id"] == "V6")
    assert added["equipment"] == ["OXYGEN", "STRETCHER"] and added["capacity"] == 2
    after = post(demo, "plans/generate")
    assert any(row["vehicle_id"] == "V6" for row in after["active_plan"]["assignments"])
    assert waiting(after) < waiting(before)


def test_editing_equipment_affects_planned_tasks_until_replanned(demo):
    initial = post(demo, "plans/generate")
    oxygen_on_v3 = {row["task_id"] for row in initial["active_plan"]["assignments"] if row["vehicle_id"] == "V3"}
    assert oxygen_on_v3
    state = demo.put("/api/vehicles/V3", json={"capacity": 1, "equipment": ["STRETCHER"],
                                               "task_types": ["PLANNED_TRANSPORT"]})
    assert state.is_success, state.text
    state = state.json()
    assert next(v for v in state["vehicles"] if v["id"] == "V3")["equipment"] == ["STRETCHER"]
    assert state["revision"] > initial["revision"]
    assert oxygen_on_v3 & {issue["task_id"] for issue in state["baseline"]["affected"]}
    for item in replan(demo, state):
        tasks = {task["id"]: task for task in state["tasks"]}
        assert not any(row["vehicle_id"] == "V3" and "OXYGEN" in tasks[row["task_id"]]["equipment"]
                       for row in item["plan"]["assignments"] if row["status"] == "PLANNED")


def test_removed_vehicle_disappears_and_its_tasks_move(demo):
    initial = post(demo, "plans/generate")
    planned = {row["task_id"] for row in initial["active_plan"]["assignments"] if row["vehicle_id"] == "V5"}
    response = demo.delete("/api/vehicles/V5")
    assert response.is_success, response.text
    state = response.json()
    assert "V5" not in {v["id"] for v in state["vehicles"]}
    assert "V5" not in {v["id"] for v in demo.get("/api/tracking").json()["vehicles"]}
    assert planned <= {issue["task_id"] for issue in state["baseline"]["affected"]}
    items = replan(demo, state)
    assert items and all(row["vehicle_id"] != "V5" for item in items for row in item["plan"]["assignments"])
    assert demo.delete("/api/vehicles/V5").status_code == 404
    assert demo.put("/api/vehicles/V5", json={"capacity": 1, "task_types": ["PLANNED_TRANSPORT"]}).status_code == 404
    assert post(demo, "vehicles", OXYGEN_VAN)["vehicles"][-1]["id"] == "V6"


def test_vehicle_on_a_transport_cannot_be_removed(demo):
    initial = post(demo, "plans/generate")
    first = min(initial["active_plan"]["assignments"], key=lambda row: row["planned_departure"])
    post(demo, "demo/advance-time", {"to": first["planned_departure"] + 60})
    response = demo.delete(f"/api/vehicles/{first['vehicle_id']}")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "VEHICLE_IN_USE"


def test_vehicle_needs_a_task_type_and_valid_capacity(demo):
    assert demo.post("/api/vehicles", json={**OXYGEN_VAN, "task_types": []}).status_code == 422
    assert demo.post("/api/vehicles", json={**OXYGEN_VAN, "capacity": 0}).status_code == 422


def test_fewest_changes_recommendation_is_always_last(demo):
    post(demo, "plans/generate")
    post(demo, "demo/advance-time", {"to": 3000})
    state = post(demo, "incidents", {"type": "VEHICLE_BREAKDOWN", "vehicle_id": "V3"})
    generated = [item["plan"]["strategy"] for item in replan(demo, state)]
    listed = [item["plan"]["strategy"] for item in demo.get("/api/recommendations").json()]
    assert "MIN_CHANGES" in generated and len(generated) >= 2
    for strategies in (generated, listed):
        assert strategies[-1] == "MIN_CHANGES"
        assert strategies == sorted(strategies, key=["MIN_DELAY", "MAX_BUFFER", "MIN_CHANGES"].index)


def test_fleet_changes_become_incidents_that_a_replan_resolves(demo):
    post(demo, "plans/generate")
    response = demo.delete("/api/vehicles/V5")
    state = response.json()
    [change] = [i for i in state["incidents"] if i["type"] == "FLEET_CHANGE"]
    assert (change["vehicle_id"], change["status"]) == ("V5", "OPEN")
    assert "odstranjeno" in change["description"]
    items = replan(demo, state)
    assert all(change["id"] in item["incident_ids"] for item in items)
    accepted = post(demo, f"recommendations/{items[0]['id']}/accept")
    assert accepted["status"] == "ACCEPTED"
    state = demo.get("/api/state").json()
    assert next(i for i in state["incidents"] if i["id"] == change["id"])["status"] == "RESOLVED"


def test_fleet_change_can_be_closed_without_replanning(demo):
    state = post(demo, "vehicles", OXYGEN_VAN)
    [change] = [i for i in state["incidents"] if i["type"] == "FLEET_CHANGE"]
    assert "V6 dodano v floto" in change["description"] and "kisik" in change["description"]
    closed = post(demo, f"incidents/{change['id']}/resolve")
    assert next(i for i in closed["incidents"] if i["id"] == change["id"])["status"] == "RESOLVED"
    assert demo.post(f"/api/incidents/{change['id']}/resolve").status_code == 409
