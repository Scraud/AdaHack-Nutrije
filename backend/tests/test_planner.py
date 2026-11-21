from app.planning.contracts import Incident, Point
from app.planning.cp_sat_planner import CpSatPlanner
from app.planning.snapshot_builder import build_snapshot, delivery, pickup
from app.planning.validator import validate_plan
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


def test_delay_and_closure_use_current_geographic_conditions():
    vehicles, facilities, tasks = demo_data()
    clear = build_snapshot(0, vehicles, tasks, facilities, [], [])
    center = Point(lat=46.038, lon=14.508)
    delay = Incident(type="TRAFFIC_DELAY", duration=100, location=center, radius_km=1, multiplier=2)
    closure = Incident(type="ROAD_CLOSURE", duration=50, location=center, radius_km=1)
    affected = pickup("T01"), delivery("T01")
    unaffected = pickup("T03"), delivery("T03")
    delayed = build_snapshot(0, vehicles, tasks, facilities, [], [delay])
    assert delayed.travel.seconds(*affected) > clear.travel.seconds(*affected)
    assert delayed.travel.seconds(*unaffected) == clear.travel.seconds(*unaffected)
    closed = build_snapshot(0, vehicles, tasks, facilities, [], [delay, closure])
    assert closed.travel.seconds(*affected) is None
    assert build_snapshot(101, vehicles, tasks, facilities, [], [delay, closure]).travel == clear.travel
    candidate = CpSatPlanner().alternatives(closed)[0].plan
    assert any(row.task_id == "T01" and row.code == "UNREACHABLE_ROUTE" for row in candidate.unassigned)
    assert not validate_plan(closed, candidate.assignments)
