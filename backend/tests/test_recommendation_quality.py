from fastapi.testclient import TestClient

from app.main import create_app
from app.planning.cp_sat_planner import TOLERANCE, _dominated
from app.services.advisor import Advisor
from tests.test_dispatch import post, replan

WEIGHT = {"P1": 4, "P2": 2, "P3": 1}


def disrupted(client, now, incidents):
    post(client, "plans/generate")
    post(client, "demo/advance-time", {"to": now})
    for incident in incidents:
        state = post(client, "incidents", incident)
    return state


def asap(task):
    return task.get("arrival_policy") == "ASAP" or (task["type"] == "PRIORITY_TRANSPORT" and task["priority"] == "P1")


def score(state, plan):
    tasks = {task["id"]: task for task in state["tasks"]}
    unassigned = sum({"P1": 1_000_000, "P2": 1_000, "P3": 1}[tasks[i["task_id"]]["priority"]] for i in plan["unassigned"])
    delay = sum(WEIGHT[tasks[r["task_id"]]["priority"]] * max(0, r["planned_dropoff"] - tasks[r["task_id"]]["preferred_arrival"])
                for r in plan["assignments"] if not asap(tasks[r["task_id"]]))
    m = plan["metrics"]
    return unassigned, delay, m["vehicle_changes"], -m["min_buffer_seconds"], m["travel_seconds"]


def test_no_mass_reshuffle_for_a_tiny_gain(tmp_path):
    with TestClient(create_app(tmp_path / "dispatch.sqlite", advisor=Advisor(None, "x"))) as client:
        state = disrupted(client, 5400, [
            {"type": "VEHICLE_BREAKDOWN", "vehicle_id": "V5"},
            {"type": "NEW_TASK", "priority": "P1", "task": {
                "priority": "P1", "pickup": {"lat": 46.03, "lon": 14.47}, "equipment": ["STRETCHER"]}},
        ])
        items = replan(client, state)
        assert items
        assert all(item["plan"]["metrics"]["vehicle_changes"] <= 2 for item in items)


def test_alternatives_are_distinct_and_not_dominated(tmp_path):
    with TestClient(create_app(tmp_path / "dispatch.sqlite", advisor=Advisor(None, "x"))) as client:
        state = disrupted(client, 3600, [
            {"type": "TRAFFIC_DELAY", "road_id": "street:Celovška cesta", "multiplier": 3.0},
            {"type": "VEHICLE_BREAKDOWN", "vehicle_id": "V1"},
            {"type": "VEHICLE_BREAKDOWN", "vehicle_id": "V4"},
        ])
        plans = [item["plan"] for item in replan(client, state)]
        assert plans
        assignments = [frozenset((r["task_id"], r["vehicle_id"]) for r in plan["assignments"]) for plan in plans]
        assert len(set(assignments)) == len(assignments)
        scores = [score(state, plan) for plan in plans]
        for i, own in enumerate(scores):
            assert not _dominated(own, scores[:i] + scores[i + 1:])
        by_strategy = {plan["strategy"]: plan["metrics"] for plan in plans}
        if "MIN_CHANGES" in by_strategy:
            assert by_strategy["MIN_CHANGES"]["vehicle_changes"] < by_strategy["MIN_DELAY"]["vehicle_changes"]


def test_tolerance_ignores_noise():
    assert _dominated((0, 0, 4, -1740, 14460), [(0, 0, 3, -1800, 14200)])
    assert not _dominated((0, 0, 3, -600, 14800), [(0, 1440, 4, -1740, 14460)])
    assert len(TOLERANCE) == 5
