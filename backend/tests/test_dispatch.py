from concurrent.futures import ThreadPoolExecutor
from json import dumps

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.providers import osrm


@pytest.fixture
def demo(tmp_path):
    with TestClient(create_app(tmp_path / "dispatch.sqlite")) as client:
        yield client


def post(client, path, body=None):
    response = client.post(f"/api/{path}", json=body)
    assert response.is_success, response.text
    return response.json()


def disruption(client):
    initial = post(client, "plans/generate")
    assert initial["active_plan"]["metrics"]["assigned"] == 20
    live = post(client, "demo/advance-time", {"to": 12000})
    assert live["baseline"]["simulated_arrivals"] == 8
    broken = post(client, "incidents", {"type": "VEHICLE_BREAKDOWN", "vehicle_id": "V3"})
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
    items = replan(demo, state)
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
        "preferred_arrival": 14500, "latest_arrival": 17500,
    }})
    new_id = state["incidents"][-1]["task_id"]
    assert {task["id"]: (task["priority"], task["facility_id"])
            for task in state["tasks"] if task["id"] != new_id} == before
    assert {"task_id": new_id, "vehicle_id": None, "code": "NO_COMPATIBLE_VEHICLE"} in (
        replan(demo, state)[0]["plan"]["unassigned"]
    )
