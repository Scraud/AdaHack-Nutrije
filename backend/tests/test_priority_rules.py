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
