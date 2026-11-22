from collections import Counter

from app.planning.contracts import Assignment, HORIZON, Issue, PlanningSnapshot
from app.planning.snapshot_builder import compatible, delivery, facility_remaining, pickup, routes


def validate_plan(snapshot: PlanningSnapshot, assignments: list[Assignment]) -> list[Issue]:
    issues = list(snapshot.blocking)
    blocked_tasks = {issue.task_id for issue in snapshot.blocking}
    seen = set()
    quotas: Counter[str] = Counter()
    for vehicle_id, route in routes(assignments).items():
        vehicle = snapshot.vehicles.get(vehicle_id)
        anchor = snapshot.anchors.get(vehicle_id)
        origin = anchor.node if anchor else ""
        available = anchor.time if anchor else 0
        for row in route:
            def fail(code: str) -> None:
                issues.append(Issue(code=code, task_id=row.task_id, vehicle_id=vehicle_id))

            task = snapshot.tasks.get(row.task_id)
            if row.task_id in seen or vehicle is None or task is None or anchor is None:
                fail("INVALID_ASSIGNMENT")
                continue
            seen.add(row.task_id)
            frozen = snapshot.frozen.get(row.task_id)
            if frozen:
                # A future locked assignment can have a different approach leg after replanning.
                schedule = (row.model_copy(update={"distance_meters": frozen.distance_meters})
                            if frozen.status == "PLANNED" and row.task_id not in blocked_tasks else row)
                if schedule != frozen:
                    fail("FROZEN_ASSIGNMENT_CHANGED")
            if frozen and (frozen.status != "PLANNED" or row.task_id in blocked_tasks):
                continue
            if not frozen:
                if row.status != "PLANNED" or row.is_locked:
                    fail("INVALID_ASSIGNMENT")
                if anchor.blocked:
                    fail("VEHICLE_UNAVAILABLE")
                facility = snapshot.facilities[task.facility_id]
                quotas[facility.id] += 1
                if quotas[facility.id] > facility_remaining(snapshot, facility.id):
                    fail("FACILITY_CAPACITY")
                if not facility.accepting:
                    fail("FACILITY_NOT_ACCEPTING")
            if not compatible(vehicle, task):
                fail("NO_COMPATIBLE_VEHICLE")
            to_pickup = snapshot.travel.seconds(origin, pickup(task.id))
            loaded = snapshot.travel.seconds(pickup(task.id), delivery(task.id))
            if to_pickup is None or loaded is None:
                fail("UNREACHABLE_ROUTE")
            elif (row.planned_departure + to_pickup > row.planned_pickup
                  or (not frozen and row.deadhead != to_pickup)
                  or row.planned_dropoff != row.planned_pickup + task.pickup_service + loaded):
                fail("INVALID_TRAVEL_TIME")
            if (row.planned_departure < available or row.planned_pickup < task.earliest_pickup
                or (task.latest_pickup is not None and row.planned_pickup > task.latest_pickup)
                or row.planned_dropoff > task.arrival_deadline or row.planned_end > HORIZON
                or row.planned_end != row.planned_dropoff + task.dropoff_service + task.cleaning
                or any(row.planned_departure < end and begin < row.planned_end
                       for begin, end in vehicle.unavailable)):
                fail("HARD_TIME_WINDOW")
            origin, available = delivery(task.id), row.planned_end
    for task in set(snapshot.frozen) - seen:
        issues.append(Issue(code="FROZEN_ASSIGNMENT_CHANGED", task_id=task))
    return issues
