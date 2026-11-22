from concurrent.futures import ThreadPoolExecutor
from json import dumps

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.db import Database
from app.main import create_app
from app.models import AssignmentRecord, IncidentRecord, TaskRecord, VehicleRecord
from app.planning.contracts import Assignment
from app.providers import osrm


@pytest.fixture
def demo(tmp_path):
    with TestClient(create_app(tmp_path / "dispatch.sqlite")) as client:
        yield client


def post(client, path, body=None):
    response = client.post(f"/api/{path}", json=body)
    assert response.is_success, response.text
    return response.json()


def test_demo_clock_outside_operating_shift(demo):
    post(demo, "plans/generate")
    midnight = post(demo, "demo/clock", {"to": -8 * 3600})
    assert midnight["now"] == -8 * 3600
    assert all(row["status"] == "PLANNED" for row in midnight["active_plan"]["assignments"])
    early = post(demo, "demo/clock", {"to": -1800})
    assert early["now"] == -1800
    start = post(demo, "demo/clock", {"to": 0})
    assert start["now"] == 0
    late = post(demo, "demo/clock", {"to": 16 * 3600 - 60})
    assert late["now"] == 16 * 3600 - 60
    assert all(row["status"] == "COMPLETED" for row in late["active_plan"]["assignments"])
    assert demo.post("/api/demo/clock", json={"to": -1800}).status_code == 400


def test_saved_pickup_after_shift_keeps_state_and_tracking_available(tmp_path):
    db_path = tmp_path / "legacy.sqlite"
    with TestClient(create_app(db_path)) as client:
        state = client.get("/api/state").json()
        with Database(db_path).session(write=True) as db:
            task = db.get(TaskRecord, ("T19", state["scenario_id"]))
            task.payload = {**task.payload, "priority": "P2", "earliest_pickup": 36_900, "latest_pickup": 39_300}

        state = client.get("/api/state")
        assert state.is_success, state.text
        saved = next(task for task in state.json()["tasks"] if task["id"] == "T19")
        assert (saved["earliest_pickup"], saved["latest_pickup"]) == (36_900, 39_600)
        assert client.get("/api/tracking").is_success
        active = post(client, "plans/generate")["active_plan"]
        assert any(issue["task_id"] == "T19" and issue["code"] == "HARD_TIME_WINDOW" for issue in active["unassigned"])
        assert all(row["task_id"] != "T19" for row in active["assignments"])

        post(client, "demo/clock", {"to": 46_800})
        response = client.post("/api/incidents", json={
            "type": "NEW_TASK", "task": {"priority": "P2", "pickup": {"lat": 46.046, "lon": 14.494}},
        })
        assert response.status_code == 400 and response.json()["detail"]["code"] == "INVALID_TASK_TIME"


def test_saved_reroute_after_shift_keeps_recommendation_history_available(tmp_path):
    db_path = tmp_path / "late-reroute.sqlite"
    with TestClient(create_app(db_path)) as client:
        state = post(client, "plans/generate")
        proposal = replan(client, state)[0]
        plan = proposal["plan"]
        task_id = plan["assignments"][0]["task_id"]
        with Database(db_path).session(write=True) as db:
            row = db.get(AssignmentRecord, (plan["id"], task_id))
            row.payload = {**row.payload, "reroute": {"at": 36_500, "start": 36_745, "leg": "PICKUP"}}

        history = client.get("/api/recommendations")
        assert history.is_success, history.text
        result = next(item for item in history.json() if item["id"] == proposal["id"])
        row = next(item for item in result["plan"]["assignments"] if item["task_id"] == task_id)
        assert (row["reroute"]["at"], row["reroute"]["start"]) == (36_500, 36_745)


def test_road_incident_can_end_after_shift(demo):
    state = post(demo, "incidents", {"type": "ROAD_CLOSURE", "location": {"lat": 46.056, "lon": 14.505}})
    post(demo, "demo/clock", {"to": 46_800})
    state = post(demo, f"incidents/{state['incidents'][0]['id']}/resolve")
    assert state["incidents"][0]["ended_at"] == 46_800
    assert demo.get("/api/tracking").is_success


@pytest.mark.parametrize("instant", [-8 * 3600 - 1, 16 * 3600])
def test_demo_clock_rejects_another_calendar_day(demo, instant):
    assert demo.post("/api/demo/clock", json={"to": instant}).status_code == 422


def disruption(client):
    initial = post(client, "plans/generate")
    assert initial["active_plan"]["metrics"]["assigned"] == 20
    live = post(client, "demo/advance-time", {"to": 12000})
    assert live["baseline"]["simulated_arrivals"] == 10
    broken = post(client, "incidents", {"type": "VEHICLE_BREAKDOWN", "vehicle_id": "V3",
                                         "description": "Tehnična okvara V3", "priority": "P1"})
    assert any(issue["vehicle_id"] == "V3" for issue in broken["baseline"]["affected"])
    assert broken["active_plan"]["id"] == initial["active_plan"]["id"]
    return broken


def replan(client, state):
    return post(client, "recommendations/generate", {
        "base_plan_id": state["active_plan"]["id"], "expected_state_revision": state["revision"],
    })["items"]


def signature(plan):
    return tuple((row["vehicle_id"], row["task_id"]) for row in plan["assignments"])





def test_demo_and_decisions(demo):
    state = disruption(demo)
    incident = state["incidents"][-1]
    assert (incident["description"], incident["priority"], incident["status"]) == (
        "Tehnična okvara V3", "P1", "OPEN")
    items = replan(demo, state)
    assert all(incident["id"] in item["incident_ids"] for item in items)
    assert len(items) >= 2
    assert len({signature(item["plan"]) for item in items}) == len(items)
    assert {item["id"] for item in replan(demo, state)} == {item["id"] for item in items}
    frozen = {row["task_id"]: row for row in state["active_plan"]["assignments"] if row["status"] != "PLANNED"}
    for item in items:
        for row in item["plan"]["assignments"]:
            if row["task_id"] in frozen:
                assert row == frozen[row["task_id"]]
            else:
                assert row["vehicle_id"] != "V3"
    original = state["active_plan"]["id"]
    post(demo, f"recommendations/{items[0]['id']}/reject", {"reason": "Stabilnost razporeda"})
    assert demo.get("/api/state").json()["active_plan"]["id"] == original
    path = f"recommendations/{items[1]['id']}/accept"
    first = post(demo, path)
    assert first["plan"]["version"] == 2 and first == post(demo, path)
    resolved = demo.get("/api/state").json()["incidents"][-1]
    assert resolved["status"] == "RESOLVED"
    assert resolved["selected_recommendation_id"] == items[1]["id"]
    assert resolved["resolved_at"]
    assert incident["id"] in first["incident_ids"]
    versions = demo.get("/api/plans").json()
    assert [(row["version"], row["status"]) for row in versions] == [(2, "ACTIVE"), (1, "SUPERSEDED")]
    assert demo.get(f"/api/plans/{original}").json()["id"] == original


def test_concurrent_approval_only_activates_one_plan(demo):
    items = replan(demo, disruption(demo))
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda item:
                                  demo.post(f"/api/recommendations/{item['id']}/accept"), items[:2]))
    success = next(response for response in responses if response.is_success)
    conflict = next(response for response in responses if not response.is_success)
    assert success.json()["plan"]["version"] == 2
    assert conflict.status_code == 409 and conflict.json()["detail"]["code"] == "STALE_RECOMMENDATION"
    assert len(demo.get("/api/plans").json()) == 2


def test_candidate_road_preview_is_read_only_and_rejects_stale_plans(demo):
    state = disruption(demo)
    items = replan(demo, state)
    before = demo.get("/api/state").json()
    history = demo.get("/api/plans").json()
    for item in items:
        response = demo.get("/api/tracking", params={"plan_id": item["plan"]["id"]})
        assert response.is_success, response.text
        frame = response.json()
        assert frame["scenario_id"] == state["scenario_id"]
        assert frame["revision"] == state["revision"]
        assert len(frame["vehicles"]) == 5
        assert any(len(v["to_pickup"]) > 2 or len(v["to_hospital"]) > 2 for v in frame["vehicles"])
    assert demo.get("/api/state").json() == before
    assert demo.get("/api/plans").json() == history
    assert demo.get("/api/tracking", params={"plan_id": "missing"}).status_code == 409
    post(demo, "vehicles/V3/restore")
    assert demo.get("/api/tracking", params={"plan_id": items[0]["plan"]["id"]}).status_code == 409


def test_repaired_vehicle_can_receive_assignments_and_invalidates_old_proposals(demo):
    state = disruption(demo)
    candidates = replan(demo, state)
    restored = post(demo, "vehicles/V3/restore")
    assert restored["revision"] == state["revision"] + 1
    assert restored["active_plan"]["id"] == state["active_plan"]["id"]
    assert not next(v for v in restored["vehicles"] if v["id"] == "V3")["broken"]
    assert restored["incidents"][-1]["status"] == "RESOLVED"
    assert post(demo, "vehicles/V3/restore")["revision"] == restored["revision"]
    assert demo.post(f"/api/recommendations/{candidates[0]['id']}/accept").status_code == 409
    refreshed = replan(demo, restored)
    assert refreshed
    assert any(a["vehicle_id"] == "V3" and a["status"] == "PLANNED"
               for item in refreshed for a in item["plan"]["assignments"])
    assert demo.post("/api/vehicles/unknown/restore").status_code == 404


@pytest.mark.parametrize("change", ["advance", "incident", "reset"])
def test_stale_recommendation(demo, change):
    state = disruption(demo)
    item = replan(demo, state)[0]
    match change:
        case "advance":
            post(demo, "demo/advance-time", {"to": state["now"] + 60})
        case "incident":
            post(demo, "incidents", {"type": "FACILITY_CAPACITY_CHANGE", "facility_id": "F1", "quota": 3})
        case "reset":
            post(demo, "demo/reset")
    response = demo.post(f"/api/recommendations/{item['id']}/accept")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "STALE_RECOMMENDATION"


def test_reset_is_reproducible_and_storage_survives_restart(tmp_path):
    path = tmp_path / "persistent.sqlite"
    with TestClient(create_app(path)) as client:
        initial = client.get("/api/state").json()
        active = post(client, "plans/generate")["active_plan"]
    with TestClient(create_app(path)) as client:
        assert client.get("/api/state").json()["active_plan"]["id"] == active["id"]
        reset = post(client, "demo/reset")
        assert reset["scenario_id"] != initial["scenario_id"]
        assert {k: v for k, v in reset.items() if k != "scenario_id"} == {
            k: v for k, v in initial.items() if k != "scenario_id"
        }
        again = post(client, "plans/generate")["active_plan"]
        assert (active["assignments"], active["metrics"]) == (again["assignments"], again["metrics"])


def test_self_hosted_road_matrix_drives_planning_and_records_distance(tmp_path, monkeypatch):
    monkeypatch.setenv("RESCUEFLOW_OSRM_URL", "http://osrm:5000")
    requests = []
    route_requests = []

    def table(_, url, *, params):
        if "/route/v1/driving/" in url:
            route_requests.append(url)
            assert params == {"geometries": "geojson", "overview": "full"}
            points = [[float(value) for value in point.split(",")] for point in url.rsplit("/", 1)[1].split(";")]
            return dumps({"code": "Ok", "routes": [{"geometry": {"coordinates": points}}]}).encode()
        assert url.startswith("http://osrm:5000/table/v1/driving/")
        assert params["annotations"] == "duration,distance"
        requests.append(url)
        size = url.count(";") + 1
        return dumps({
            "code": "Ok",
            "durations": [[0 if i == j else 601 for j in range(size)] for i in range(size)],
            "distances": [[0 if i == j else 2200 for j in range(size)] for i in range(size)],
        }).encode()

    monkeypatch.setattr(osrm, "fetch", table)
    with TestClient(create_app(tmp_path / "roads.sqlite")) as client:
        assert client.get("/api/state").json()["travel_source"] == "OSRM"
        initial = post(client, "plans/generate")["active_plan"]
        tasks = initial["assignments"]
        assert len(tasks) == 20
        assert all(row["deadhead"] == 601 and row["distance_meters"] == 4400 for row in tasks)
        assert initial["metrics"]["distance_meters"] == len(tasks) * 4400
        assert len(requests) == 1

        tracked = client.get("/api/tracking").json()["vehicles"]
        assert any(len(vehicle["to_pickup"]) == len(vehicle["to_hospital"]) == 2 for vehicle in tracked)
        scheduled = {row["task_id"]: row for row in tasks}
        for vehicle in tracked:
            if vehicle["task_id"] is not None:
                assert vehicle["eta"] == {
                    "destination": "PICKUP", "seconds": scheduled[vehicle["task_id"]]["planned_pickup"],
                }
        assert route_requests
        count = len(route_requests)
        assert client.get("/api/tracking").is_success
        assert len(route_requests) == count

        state = post(client, "incidents", {"type": "VEHICLE_BREAKDOWN", "vehicle_id": "V3"})
        proposal = replan(client, state)[0]
        accepted = post(client, f"recommendations/{proposal['id']}/accept")["plan"]
        assert accepted["metrics"]["distance_meters"] == sum(row["distance_meters"] for row in accepted["assignments"])
        assert len(requests) == 1


def test_configured_osrm_unavailable_does_not_generate_an_estimated_plan(tmp_path, monkeypatch):
    monkeypatch.setenv("RESCUEFLOW_OSRM_URL", "http://osrm:5000")

    def unavailable(*args, **kwargs):
        raise httpx.ConnectError("local OSRM offline")

    monkeypatch.setattr(osrm, "fetch", unavailable)
    with TestClient(create_app(tmp_path / "unavailable.sqlite")) as client:
        response = client.post("/api/plans/generate")
        assert response.status_code == 503
        assert response.json()["detail"]["code"] == "ROAD_ROUTING_UNAVAILABLE"
        assert client.get("/api/plans").json() == []


def test_failure_during_transport_requires_manual_coordination(demo):
    initial = post(demo, "plans/generate")
    row = next(row for row in initial["active_plan"]["assignments"] if row["vehicle_id"] == "V3")
    post(demo, "demo/advance-time", {"to": row["planned_pickup"] + 1})
    state = post(demo, "incidents", {"type": "VEHICLE_BREAKDOWN", "vehicle_id": "V3"})
    warning = {"task_id": row["task_id"], "vehicle_id": "V3", "code": "MANUAL_COORDINATION"}
    assert warning in state["baseline"]["affected"]
    item = replan(demo, state)[0]
    assert warning in item["plan"]["blocking"]
    response = demo.post(f"/api/recommendations/{item['id']}/accept")
    assert response.status_code == 409 and response.json()["detail"]["code"] == "BLOCKED_PLAN"
    later = post(demo, "demo/advance-time", {"to": row["planned_end"] + 60})
    task = next(task for task in later["tasks"] if task["id"] == row["task_id"])
    assert task["actual_pickup"] is not None and task["actual_arrival"] is None
    assert later["active_plan"]["version"] == 1


def test_dispatcher_supplies_priority_and_impossible_task_is_explained(demo):
    state = disruption(demo)
    before = {task["id"]: (task["priority"], task["facility_id"]) for task in state["tasks"]}
    state = post(demo, "incidents", {"type": "NEW_TASK", "task": {
        "priority": "P1", "facility_id": "F3", "pickup": {"lat": 46.068, "lon": 14.542},
        "passenger_count": 8, "equipment": ["OXYGEN"], "earliest_pickup": 12900,
    }})
    new_id = state["incidents"][-1]["task_id"]
    assert {task["id"]: (task["priority"], task["facility_id"])
            for task in state["tasks"] if task["id"] != new_id} == before
    assert {"task_id": new_id, "vehicle_id": None, "code": "NO_COMPATIBLE_VEHICLE"} in (
        replan(demo, state)[0]["plan"]["unassigned"]
    )


def test_priority_task_uses_local_address_and_priority_pickup_window(demo):
    response = demo.get("/api/map/addresses", params={"query": "  zaloska cesta, 2 "})
    assert response.is_success
    [address] = response.json()
    assert address["name"] == "Zaloška cesta 2"
    now = 12000
    post(demo, "demo/advance-time", {"to": now})
    for priority, latest in (("P1", None), ("P2", now + 45 * 60), ("P3", now + 120 * 60)):
        state = post(demo, "incidents", {"type": "NEW_TASK", "task": {
            "pickup": {"lat": address["lat"], "lon": address["lon"]},
            "pickup_name": address["name"], "priority": priority,
        }})
        event = state["incidents"][-1]
        task = next(task for task in state["tasks"] if task["id"] == event["task_id"])
        assert (task["pickup_name"], task["facility_id"]) == (address["name"], "F1")
        assert (task["earliest_pickup"], task["latest_pickup"]) == (now, latest)
        assert "preferred_arrival" not in task and "latest_arrival" not in task


@pytest.mark.parametrize("urgency", ["new", "legacy", "already_assigned"])
def test_high_priority_can_redirect_approaching_vehicle_but_keeps_picked_up_passenger(demo, tmp_path, urgency):
    database = Database(tmp_path / "dispatch.sqlite")
    with database.session(write=True) as db:
        db.execute(delete(TaskRecord))
        db.execute(delete(VehicleRecord).where(VehicleRecord.id != "V3"))
    def add_task(priority, lat, lon):
        state = post(demo, "incidents", {"type": "NEW_TASK", "task": {
            "priority": priority, "pickup": {"lat": lat, "lon": lon}, "equipment": ["OXYGEN"],
        }})
        return state, state["incidents"][-1]["task_id"]

    _, low = add_task("P3", 46.04, 14.55)
    initial = post(demo, "plans/generate")
    [approach] = initial["active_plan"]["assignments"]
    assert approach["planned_departure"] == 0
    now = approach["planned_pickup"] // 2
    post(demo, "demo/advance-time", {"to": now})
    state, high = add_task("P1", 46.065, 14.535)
    with database.session(write=True) as db:
        if urgency == "legacy":
            # Payloads stored before the priority rules still load, and red stays first.
            record = db.get(TaskRecord, (high, state["scenario_id"]))
            record.payload = {**record.payload, "arrival_policy": None, "latest_pickup": now + 60,
                              "preferred_arrival": now + 60, "latest_arrival": now + 60}
        elif urgency == "already_assigned":
            # Simulate an older accepted plan that put the urgent transport behind the low one.
            departure = approach["planned_end"]
            row = Assignment(task_id=high, vehicle_id="V3", planned_departure=departure,
                             planned_pickup=departure + 300, planned_dropoff=departure + 840,
                             planned_end=departure + 1200, deadhead=300)
            db.add(AssignmentRecord(plan_id=state["active_plan"]["id"], task_id=high,
                                    payload=row.model_dump(mode="json")))
            incident = db.get(IncidentRecord, state["incidents"][-1]["id"])
            incident.payload = {**incident.payload, "status": "RESOLVED"}
    database.engine.dispose()
    original = demo.get("/api/tracking").json()["vehicles"][0]
    assert original["task_id"] == low and original["status"] == "TO_PICKUP"
    item = replan(demo, state)[0]
    assert item["plan"]["released_task_ids"] == [low]
    first, second = item["plan"]["assignments"]
    assert first["task_id"] == high and second["task_id"] == low
    assert first["planned_departure"] == now
    preview = demo.get("/api/tracking", params={"plan_id": item["plan"]["id"]}).json()["vehicles"][0]
    assert preview["task_id"] == high
    assert preview["location"] == original["location"]
    assert demo.get("/api/tracking").json()["vehicles"][0] == original
    post(demo, f"recommendations/{item['id']}/accept")
    assert demo.get("/api/tracking").json()["vehicles"][0] == preview

    post(demo, "demo/advance-time", {"to": second["planned_pickup"] + 1})
    state, next_high = add_task("P1", 46.06, 14.52)
    [item] = replan(demo, state)
    assert item["plan"]["released_task_ids"] == []
    active_low = next(row for row in state["active_plan"]["assignments"] if row["task_id"] == low)
    assignments = {row["task_id"]: row for row in item["plan"]["assignments"]}
    assert assignments[low] == active_low
    assert assignments[next_high]["planned_departure"] >= active_low["planned_end"]
