from app.planning.contracts import Anchor, Assignment, Facility, Incident, Issue, Node, PlanningSnapshot, Task, Vehicle
from app.providers.haversine import local_snapshot


def start(vehicle_id: str) -> str:
    return f"vehicle:{vehicle_id}"


def pickup(task_id: str) -> str:
    return f"pickup:{task_id}"


def delivery(task_id: str) -> str:
    return f"delivery:{task_id}"


def build_nodes(vehicles: list[Vehicle], tasks: list[Task], facilities: dict[str, Facility]) -> tuple[Node, ...]:
    nodes = [Node(start(v.id), "VEHICLE_START", v.location) for v in vehicles]
    for task in tasks:
        nodes.append(Node(pickup(task.id), "PICKUP", task.pickup))
        nodes.append(Node(delivery(task.id), "DELIVERY", facilities[task.facility_id].location))
    return tuple(nodes)


def build_snapshot(now: int, vehicles: list[Vehicle], tasks: list[Task], facilities: list[Facility],
                   assignments: list[Assignment], incidents: list[Incident]) -> PlanningSnapshot:
    destinations = {f.id: f for f in facilities}
    current = {a.task_id: a for a in assignments}
    frozen = {a.task_id: a for a in assignments if a.is_locked or a.status != "PLANNED"}
    conditions = [i for i in incidents if i.type in ("ROAD_CLOSURE", "TRAFFIC_DELAY", "WEATHER_DELAY")
                  and i.occurred_at <= now and (i.duration is None or now < i.occurred_at + i.duration)]
    travel = local_snapshot(build_nodes(vehicles, tasks, destinations), conditions)
    anchors = {}
    blocking = []
    by_task = {t.id: t for t in tasks}
    for vehicle in vehicles:
        history = sorted((a for a in frozen.values() if a.vehicle_id == vehicle.id),
                         key=lambda a: a.planned_departure)
        in_progress = next((a for a in history if a.status == "IN_PROGRESS"), None)
        completed = [a for a in history if a.status == "COMPLETED"]
        anchor = Anchor(start(vehicle.id), max(now, vehicle.available_at))
        if completed:
            anchor = Anchor(delivery(completed[-1].task_id), max(now, vehicle.available_at))
        blocked = vehicle.broken
        for assignment in history:
            if assignment.status == "COMPLETED":
                continue
            task = by_task[assignment.task_id]
            loaded = travel.seconds(pickup(task.id), delivery(task.id))
            facility = destinations[task.facility_id]
            approach = None
            if assignment.status == "IN_PROGRESS" and task.actual_pickup is None:
                approach = travel.seconds(anchor.node, pickup(task.id))
            approaching = assignment.status == "IN_PROGRESS" and task.actual_pickup is None
            failure = (vehicle.broken
                       or any(assignment.planned_departure < end and begin < assignment.planned_end
                              for begin, end in vehicle.unavailable)
                       or (approaching and (approach is None or
                           assignment.planned_departure + approach > assignment.planned_pickup))
                       or (task.actual_arrival is None and (
                           loaded is None or assignment.planned_pickup + task.pickup_service + loaded
                           > assignment.planned_dropoff
                           or not facility.accepting)))
            if failure:
                code = "MANUAL_COORDINATION" if assignment.status == "IN_PROGRESS" and task.actual_pickup is not None else "LOCKED_EXECUTION_BLOCKED"
                blocking.append(Issue(code=code, task_id=task.id, vehicle_id=vehicle.id))
                blocked = True
        if in_progress:
            anchor = Anchor(delivery(in_progress.task_id), max(anchor.time, in_progress.planned_end))
        anchors[vehicle.id] = Anchor(anchor.node, anchor.time, blocked)
    return PlanningSnapshot(now, {v.id: v for v in vehicles}, by_task, destinations,
                            current, frozen, anchors, travel, tuple(blocking))


def compatible(vehicle: Vehicle, task: Task) -> bool:
    return (task.type in vehicle.task_types and task.passenger_count <= vehicle.capacity
            and set(task.equipment).issubset(vehicle.equipment))


def facility_remaining(snapshot: PlanningSnapshot, facility_id: str) -> int:
    reserved = sum(snapshot.tasks[a.task_id].facility_id == facility_id for a in snapshot.frozen.values())
    return max(0, snapshot.facilities[facility_id].quota - reserved)


def routes(assignments: list[Assignment]) -> dict[str, list[Assignment]]:
    by_vehicle: dict[str, list[Assignment]] = {}
    for assignment in sorted(assignments, key=lambda row: (row.vehicle_id, row.planned_departure, row.task_id)):
        by_vehicle.setdefault(assignment.vehicle_id, []).append(assignment)
    return by_vehicle
