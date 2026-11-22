from dataclasses import replace

import pytest

from app.planning.contracts import Incident, Point
from app.planning.cp_sat_planner import CpSatPlanner
from app.planning.snapshot_builder import build_snapshot, delivery, pickup
from app.planning.validator import validate_plan
from app.providers.haversine import local_snapshot
from app.seed.scenario import demo_data


def test_validator_detects_bad_vehicle_time_and_duplicate():
    vehicles, facilities, tasks = demo_data()
    snapshot = build_snapshot(0, vehicles, tasks, facilities, [], [])
    plan = CpSatPlanner().alternatives(snapshot)[0].plan
    assert len(plan.assignments) == 20
    assert validate_plan(snapshot, plan.assignments) == []
    original = next(row for row in plan.assignments if row.task_id == "T03")
    broken = original.model_copy(update={"vehicle_id": "V1", "planned_pickup": 0})
    errors = validate_plan(snapshot, [broken, original])
    assert {error.code for error in errors} >= {
        "NO_COMPATIBLE_VEHICLE", "INVALID_TRAVEL_TIME", "HARD_TIME_WINDOW", "INVALID_ASSIGNMENT",
    }


def test_locked_future_job_reserves_its_time_and_location():
    vehicles, facilities, tasks = demo_data()
    snapshot = build_snapshot(0, vehicles, tasks, facilities, [], [])
    planner = CpSatPlanner()
    original = planner.alternatives(snapshot)[0].plan
    locked = original.assignments[3].model_copy(update={"is_locked": True})
    snapshot = build_snapshot(0, vehicles, tasks, facilities, [locked], [])
    for result in planner.alternatives(snapshot):
        if result.plan:
            assert locked in result.plan.assignments
            assert validate_plan(snapshot, result.plan.assignments) == []
    assert planner.alternatives(snapshot)[0].plan.metrics.assigned == 20


def example_road_matrix(nodes):
    estimate = local_snapshot(nodes, [])
    distances = tuple(tuple(0 if a.point == b.point else 1500 for b in nodes) for a in nodes)
    return replace(estimate, source="OSRM", distances=distances)


@pytest.mark.parametrize("passengers,expected", [(2, 2), (3, 0)])
def test_group_capacity_and_sequential_transport_without_ride_pooling(passengers, expected):
    vehicles, facilities, tasks = demo_data()
    vehicle = vehicles[0].model_copy(update={"capacity": 2, "equipment": ["OXYGEN", "STRETCHER", "WHEELCHAIR"],
                                           "task_types": ["PLANNED_TRANSPORT"]})
    jobs = [task.model_copy(update={"passenger_count": passengers, "equipment": [], "type": "PLANNED_TRANSPORT",
                                    "earliest_pickup": 0, "latest_pickup": None,
                                    "preferred_arrival": 20000, "latest_arrival": 30000}) for task in tasks[:2]]
    snapshot = build_snapshot(0, [vehicle], jobs, facilities, [], [])
    plan = CpSatPlanner().alternatives(snapshot)[0].plan
    assert plan is not None and len(plan.assignments) == expected
    assert not validate_plan(snapshot, plan.assignments)
    rows = sorted(plan.assignments, key=lambda row: row.planned_departure)
    for first, second in zip(rows, rows[1:]):
        assert second.planned_departure >= first.planned_end


@pytest.mark.parametrize("provider", [None, example_road_matrix])
def test_delay_and_closure_use_current_geographic_conditions(provider):
    vehicles, facilities, tasks = demo_data()
    clear = build_snapshot(0, vehicles, tasks, facilities, [], [], provider)
    center = Point(lat=46.038, lon=14.508)
    delay = Incident(type="TRAFFIC_DELAY", duration=100, location=center, radius_km=1, multiplier=2)
    closure = Incident(type="ROAD_CLOSURE", duration=50, location=center, radius_km=1)
    affected = pickup("T01"), delivery("T01")
    unaffected = pickup("T03"), delivery("T03")
    delayed = build_snapshot(0, vehicles, tasks, facilities, [], [delay], provider)
    assert delayed.travel.seconds(*affected) > clear.travel.seconds(*affected)
    assert delayed.travel.seconds(*unaffected) == clear.travel.seconds(*unaffected)
    closed = build_snapshot(0, vehicles, tasks, facilities, [], [delay, closure], provider)
    assert closed.travel.seconds(*affected) is None
    assert delayed.travel.meters(*affected) == clear.travel.meters(*affected)
    assert closed.travel.meters(*affected) is None
    assert build_snapshot(101, vehicles, tasks, facilities, [], [delay, closure], provider).travel == clear.travel
    candidate = CpSatPlanner().alternatives(closed)[0].plan
    assert any(row.task_id == "T01" and row.code == "UNREACHABLE_ROUTE" for row in candidate.unassigned)
    assert not validate_plan(closed, candidate.assignments)
