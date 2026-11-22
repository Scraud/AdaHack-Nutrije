from collections import Counter
from statistics import median

from app.planning.contracts import Assignment, Change, Issue, Metrics, PlanningSnapshot
from app.planning.snapshot_builder import compatible, delivery, facility_remaining, pickup, routes, transport_distance


def explain(snapshot: PlanningSnapshot, task_id: str) -> Issue:
    task = snapshot.tasks[task_id]
    facility = snapshot.facilities[task.facility_id]
    vehicles = [v for v in snapshot.vehicles.values() if compatible(v, task)]
    loaded = snapshot.travel.seconds(pickup(task.id), delivery(task.id))
    if not facility.accepting:
        code = "FACILITY_NOT_ACCEPTING"
    elif facility_remaining(snapshot, facility.id) == 0:
        code = "FACILITY_CAPACITY"
    elif not vehicles:
        code = "NO_COMPATIBLE_VEHICLE"
    elif all(snapshot.anchors[v.id].blocked for v in vehicles):
        code = "VEHICLE_UNAVAILABLE"
    elif loaded is None:
        code = "UNREACHABLE_ROUTE"
    elif max(snapshot.now, task.earliest_pickup) > min(
        task.latest_pickup if task.latest_pickup is not None else snapshot.horizon,
        task.arrival_deadline - loaded - task.pickup_service,
        snapshot.horizon - loaded - task.pickup_service - task.dropoff_service - task.cleaning,
    ):
        code = "HARD_TIME_WINDOW"
    else:
        code = "NOT_SCHEDULED_WITHIN_BUDGET"
    return Issue(code=code, task_id=task.id)


def predecessors(assignments: list[Assignment]) -> dict[str, str | None]:
    result = {}
    for route in routes(assignments).values():
        previous = None
        for row in route:
            result[row.task_id] = previous
            previous = row.task_id
    return result


def metrics(snapshot: PlanningSnapshot, assignments: list[Assignment]) -> tuple[Metrics, list[Change]]:
    current = {row.task_id: row for row in assignments}
    old_predecessors = predecessors(list(snapshot.previous.values()))
    new_predecessors = predecessors(assignments)
    result = Metrics(assigned=len(current))
    if snapshot.travel.distances is not None and all(row.distance_meters is not None for row in assignments):
        result.distance_meters = sum(row.distance_meters or 0 for row in assignments)
    changes = []
    for task_id, task in snapshot.tasks.items():
        row, before = current.get(task_id), snapshot.previous.get(task_id)
        if row is None:
            result.unassigned[task.priority] += 1
        elif not task.arrival_asap:
            delay = max(0, row.planned_dropoff - task.preferred_arrival)
            result.late_tasks += int(delay > 0)
            result.delay_seconds += delay
        if snapshot.previous and not (before is None and row is None):
            old_vehicle = before.vehicle_id if before else None
            new_vehicle = row.vehicle_id if row else None
            old_pickup = before.planned_pickup if before else None
            new_pickup = row.planned_pickup if row else None
            vehicle_changed = old_vehicle != new_vehicle
            sequence_changed = bool(before and row and old_predecessors[task_id] != new_predecessors[task_id])
            time_changed = bool(before and row and old_pickup != new_pickup)
            result.vehicle_changes += int(vehicle_changed)
            result.sequence_changes += int(sequence_changed)
            result.time_changes += int(time_changed)
            if vehicle_changed or sequence_changed or time_changed:
                changes.append(Change(task_id=task_id, old_vehicle_id=old_vehicle, new_vehicle_id=new_vehicle,
                                      old_pickup=old_pickup, new_pickup=new_pickup))
    buffers = []
    for vehicle_id, route in routes(assignments).items():
        vehicle = snapshot.vehicles[vehicle_id]
        later = None
        for row in reversed(route):
            task = snapshot.tasks[row.task_id]
            result.travel_seconds += row.deadhead + row.planned_dropoff - row.planned_pickup - task.pickup_service
            if row.status != "PLANNED":
                continue
            latest = min(task.arrival_deadline - (row.planned_dropoff - row.planned_pickup),
                         task.latest_pickup if task.latest_pickup is not None else snapshot.horizon,
                         snapshot.horizon - (row.planned_end - row.planned_pickup))
            if later:
                next_row, next_pickup = later
                leg = snapshot.travel.seconds(delivery(task.id), pickup(next_row.task_id))
                if leg is None:
                    latest = row.planned_pickup
                else:
                    next_departure = (next_row.planned_departure if next_row.is_locked
                                      else next_pickup - leg)
                    latest = min(latest, next_departure - (row.planned_end - row.planned_pickup))
            for begin, end in vehicle.unavailable:
                if row.planned_end <= begin < latest + row.planned_end - row.planned_pickup and end > begin:
                    latest = min(latest, begin - (row.planned_end - row.planned_pickup))
            if row.is_locked:
                latest = row.planned_pickup
            else:
                buffers.append(max(0, latest - row.planned_pickup))
            later = row, latest
    if buffers:
        result.min_buffer_seconds = min(buffers)
        result.median_buffer_seconds = int(median(buffers))
    return result, changes


def project_existing(snapshot: PlanningSnapshot, assignments: list[Assignment]) -> tuple[Metrics, list[Issue]]:
    """Evaluate the existing routes with current travel times while retaining vehicle and order."""
    projected = []
    affected = list(snapshot.blocking)
    blocked = {issue.task_id for issue in affected}
    arrivals: Counter[str] = Counter()
    for vehicle_id, route in routes(assignments).items():
        anchor = snapshot.anchors[vehicle_id]
        vehicle = snapshot.vehicles[vehicle_id]
        origin, available = anchor.node, anchor.time
        for row in route:
            def report(code: str):
                affected.append(Issue(code=code, task_id=row.task_id, vehicle_id=vehicle_id))

            if row.task_id in blocked:
                continue
            if row.status != "PLANNED":
                projected.append(row)
                continue
            task = snapshot.tasks[row.task_id]
            facility = snapshot.facilities[task.facility_id]
            if anchor.blocked:
                report("VEHICLE_UNAVAILABLE")
                continue
            if not facility.accepting:
                report("FACILITY_NOT_ACCEPTING")
                continue
            if not row.is_locked and arrivals[facility.id] >= facility_remaining(snapshot, facility.id):
                report("FACILITY_CAPACITY")
                continue
            deadhead = snapshot.travel.seconds(origin, pickup(task.id))
            loaded = snapshot.travel.seconds(pickup(task.id), delivery(task.id))
            if deadhead is None or loaded is None:
                report("UNREACHABLE_ROUTE")
                continue
            depart = max(row.planned_departure, available)
            take = max(row.planned_pickup, depart + deadhead)
            arrive = take + task.pickup_service + loaded
            end = arrive + task.dropoff_service + task.cleaning
            if any(depart < until and begin < end for begin, until in vehicle.unavailable):
                report("VEHICLE_UNAVAILABLE")
                continue
            if (
                (task.latest_pickup is not None and take > task.latest_pickup)
                or arrive > task.arrival_deadline or end > snapshot.horizon
                or (row.is_locked and (depart, take, arrive, end) !=
                    (row.planned_departure, row.planned_pickup, row.planned_dropoff, row.planned_end))
            ):
                report("HARD_TIME_WINDOW" if not row.is_locked else "LOCKED_EXECUTION_BLOCKED")
                continue
            if (take, arrive) != (row.planned_pickup, row.planned_dropoff):
                report("INVALID_TRAVEL_TIME")
            if not row.is_locked:
                arrivals[facility.id] += 1
            projected.append(row.model_copy(update={
                "planned_departure": depart, "planned_pickup": take, "planned_dropoff": arrive,
                "planned_end": end, "deadhead": deadhead,
                "distance_meters": transport_distance(snapshot.travel, origin, task.id),
            }))
            origin, available = delivery(task.id), end
    result, _ = metrics(snapshot, projected)
    result.vehicle_changes = result.sequence_changes = result.time_changes = 0
    return result, affected
