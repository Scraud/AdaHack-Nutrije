import pytest

from app.planning.contracts import Point, Task, Vehicle
from app.planning.cp_sat_planner import CpSatPlanner
from app.planning.snapshot_builder import build_snapshot
from app.planning.validator import validate_plan
from app.seed.scenario import demo_data


def task(task_id, priority, lat, lon, earliest=600, latest_pickup=None):
    return Task(id=task_id, type="PLANNED_TRANSPORT", priority=priority, pickup=Point(lat=lat, lon=lon),
                facility_id="F1", passenger_count=1, earliest_pickup=earliest, latest_pickup=latest_pickup)


@pytest.mark.parametrize("priority,latest", [("P1", None), ("P2", 600 + 45 * 60), ("P3", 600 + 120 * 60)])
def test_latest_pickup_follows_priority_and_ignores_submitted_value(priority, latest):
    assert task("X", priority, 46.05, 14.5, latest_pickup=999).latest_pickup == latest


def test_old_payload_with_arrival_fields_still_loads():
    stored = {"id": "T", "type": "PLANNED_TRANSPORT", "priority": "P2", "pickup": {"lat": 46.05, "lon": 14.5},
              "facility_id": "F1", "passenger_count": 1, "earliest_pickup": 600, "latest_pickup": 900,
              "arrival_policy": "PRIORITY_WINDOW", "preferred_arrival": 1200, "latest_arrival": 2400}
    loaded = Task.model_validate(stored)
    assert loaded.latest_pickup == 600 + 45 * 60 and not hasattr(loaded, "preferred_arrival")


def test_red_goes_first_even_when_a_medium_task_is_closer():
    _, facilities, _ = demo_data()
    vehicle = Vehicle(id="V1", location=Point(lat=46.046, lon=14.494), capacity=2, equipment=[],
                      task_types=["PLANNED_TRANSPORT"])
    near = task("NEAR", "P2", 46.047, 14.495)
    far = task("FAR", "P1", 46.075, 14.53)
    snapshot = build_snapshot(0, [vehicle], [near, far], facilities, [], [])
    plan = CpSatPlanner().alternatives(snapshot)[0].plan
    first, second = sorted(plan.assignments, key=lambda row: row.planned_pickup)
    assert (first.task_id, second.task_id) == ("FAR", "NEAR")
    assert second.planned_pickup <= near.latest_pickup
    assert validate_plan(snapshot, plan.assignments) == []


def test_seed_plan_respects_every_pickup_window():
    vehicles, facilities, tasks = demo_data()
    snapshot = build_snapshot(0, vehicles, tasks, facilities, [], [])
    plan = CpSatPlanner().alternatives(snapshot)[0].plan
    by_id = {item.id: item for item in tasks}
    assert len(plan.assignments) == len(tasks)
    waits = {"P1": [], "P2": [], "P3": []}
    for row in plan.assignments:
        item = by_id[row.task_id]
        assert row.planned_pickup >= item.earliest_pickup
        assert item.latest_pickup is None or row.planned_pickup <= item.latest_pickup
        waits[item.priority].append(row.planned_pickup - item.earliest_pickup)
    # The seed makes four oxygen transports compete for three oxygen vehicles in every wave.
    assert max(waits["P1"]) == 0
    assert sum(waits["P2"]) / len(waits["P2"]) < sum(waits["P3"]) / len(waits["P3"])
    assert max(waits["P3"]) > 0
    assert {row.vehicle_id for row in plan.assignments} == {vehicle.id for vehicle in vehicles}


def test_overloaded_vehicle_never_drops_tasks_and_shifts_low_priority_first():
    _, facilities, _ = demo_data()
    vehicle = Vehicle(id="V1", location=Point(lat=46.046, lon=14.494), capacity=2, equipment=[],
                      task_types=["PLANNED_TRANSPORT"])
    # Six simultaneous pickups across town for one vehicle: not every window can be met.
    jobs = [task(f"M{i}", "P2", 46.078 + i * .002, 14.508) for i in range(2)]
    jobs += [task(f"L{i}", "P3", 46.08 + i * .002, 14.52) for i in range(4)]
    snapshot = build_snapshot(0, [vehicle], jobs, facilities, [], [])
    plan = CpSatPlanner().alternatives(snapshot)[0].plan
    assert plan.unassigned == []
    assert validate_plan(snapshot, plan.assignments) == []
    by_id = {job.id: job for job in jobs}
    over = {row.task_id: max(0, row.planned_pickup - by_id[row.task_id].latest_pickup) for row in plan.assignments}
    assert all(over[job.id] == 0 for job in jobs if job.priority == "P2")
    assert any(over[job.id] > 0 for job in jobs if job.priority == "P3")


def test_overloaded_day_with_a_new_red_task_keeps_every_task(tmp_path):
    from fastapi.testclient import TestClient

    from app.main import create_app
    from app.services.advisor import Advisor
    from tests.test_dispatch import post, replan

    with TestClient(create_app(tmp_path / "x.sqlite", advisor=Advisor(None, "x"))) as client:
        post(client, "incidents", {"type": "VEHICLE_BREAKDOWN", "vehicle_id": "V5"})
        post(client, "incidents", {"type": "VEHICLE_BREAKDOWN", "vehicle_id": "V3"})
        assert post(client, "plans/generate")["active_plan"]["unassigned"] == []
        post(client, "demo/advance-time", {"to": 12000})
        state = post(client, "incidents", {"type": "NEW_TASK", "priority": "P1", "task": {
            "priority": "P1", "pickup": {"lat": 46.075, "lon": 14.47}, "equipment": ["OXYGEN"]}})
        items = replan(client, state)
        assert items and all(item["plan"]["unassigned"] == [] for item in items)
        flags = client.get(f"/api/recommendations/{items[0]['id']}/explanation").json()["flags"]
        assert any(flag["code"] == "WINDOW_EXCEEDED" for flag in flags)


def test_new_task_goes_to_a_centre_with_room_so_no_task_is_dropped(tmp_path):
    from fastapi.testclient import TestClient

    from app.main import create_app
    from app.services.advisor import Advisor
    from tests.test_dispatch import post, replan

    with TestClient(create_app(tmp_path / "x.sqlite", advisor=Advisor(None, "x"))) as client:
        post(client, "plans/generate")
        post(client, "demo/advance-time", {"to": 12000})
        post(client, "incidents", {"type": "FACILITY_CAPACITY_CHANGE", "facility_id": "F1", "quota": 8})
        state = post(client, "incidents", {"type": "NEW_TASK", "priority": "P1", "task": {
            "priority": "P1", "pickup": {"lat": 46.0343, "lon": 14.5117}, "equipment": ["OXYGEN"],
            "earliest_pickup": 18000}})
        new = next(task for task in state["tasks"] if task["id"].startswith("N"))
        assert new["facility_id"] != "F1"
        items = replan(client, state)
        assert items and all(item["plan"]["unassigned"] == [] for item in items)


def test_a_lowered_quota_is_named_as_the_reason(tmp_path):
    from fastapi.testclient import TestClient

    from app.main import create_app
    from app.services.advisor import Advisor
    from tests.test_dispatch import post, replan

    with TestClient(create_app(tmp_path / "x.sqlite", advisor=Advisor(None, "x"))) as client:
        post(client, "plans/generate")
        state = post(client, "incidents", {"type": "FACILITY_CAPACITY_CHANGE", "facility_id": "F1", "quota": 6})
        unassigned = replan(client, state)[0]["plan"]["unassigned"]
        assert len(unassigned) == 2 and {issue["code"] for issue in unassigned} == {"FACILITY_CAPACITY"}


def test_all_full_facilities_are_reported_for_manual_and_demo_tasks(tmp_path):
    from fastapi.testclient import TestClient

    from app.main import create_app
    from app.services.advisor import Advisor
    from tests.test_dispatch import post

    with TestClient(create_app(tmp_path / "x.sqlite", advisor=Advisor(None, "x"))) as client:
        state = client.get("/api/state").json()
        for facility in state["facilities"]:
            post(client, "incidents", {"type": "FACILITY_CAPACITY_CHANGE", "facility_id": facility["id"], "quota": 0})
        state = post(client, "incidents", {"type": "NEW_TASK", "task": {
            "priority": "P1", "pickup": {"lat": 46.0343, "lon": 14.5117},
        }})
        plan = post(client, "plans/generate")["active_plan"]
        assert {issue["task_id"]: issue["code"] for issue in plan["unassigned"]} == dict.fromkeys(
            (task["id"] for task in state["tasks"]), "ALL_FACILITIES_FULL",
        )
