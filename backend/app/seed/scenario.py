from collections import Counter

from app.api.schemas import NewTask
from app.planning.contracts import Equipment, Facility, Node, Point, Priority, Task, Vehicle
from app.planning.snapshot_builder import travel_snapshot
from app.planning.task_creation import facility_nodes, priority_transport

DEMO_START = "2026-11-21T07:00:00Z"
PRESENTATION_LOW = "DEMO-LOW"
BREAKDOWN_VEHICLE = "V1"
BREAKDOWN_AT = 150
BREAKDOWN_OXYGEN = "DEMO2-OXYGEN"
BREAKDOWN_WHEELCHAIR = "DEMO2-WHEELCHAIR"


def demo_fleet() -> tuple[list[Vehicle], list[Facility]]:
    facilities = [
        Facility(id="F1", name="Center Trnovski most", location=Point(lat=46.038, lon=14.503), quota=12),
        Facility(id="F2", name="Center Zeleni gaj", location=Point(lat=46.066, lon=14.476), quota=12),
        Facility(id="F3", name="Center Severni park", location=Point(lat=46.084, lon=14.512), quota=12),
        Facility(id="F4", name="Center Vzhodni breg", location=Point(lat=46.051, lon=14.566), quota=12),
    ]
    equipment: list[list[Equipment]] = [
        ["WHEELCHAIR"], ["STRETCHER"], ["STRETCHER", "OXYGEN"],
        ["WHEELCHAIR", "STRETCHER", "OXYGEN"], ["STRETCHER", "OXYGEN"],
    ]
    starts = [(46.046, 14.494), (46.067, 14.515), (46.078, 14.530), (46.044, 14.551), (46.054, 14.477)]
    vehicles = [
        Vehicle(id=f"V{i + 1}", equipment=equipment[i], capacity=1 if i in (1, 2) else 2,
                location=Point(lat=lat, lon=lon),
                task_types=["PLANNED_TRANSPORT", "PRIORITY_TRANSPORT", "EQUIPMENT_DELIVERY"])
        for i, (lat, lon) in enumerate(starts)
    ]
    return vehicles, facilities


def demo_data() -> tuple[list[Vehicle], list[Facility], list[Task]]:
    vehicles, facilities = demo_fleet()
    requests: list[tuple[str, NewTask, int]] = []
    waves = (22, 140, 285, 430)
    # Every wave asks for four oxygen transports within minutes, but only V3, V4 and V5 carry oxygen,
    # so priority decides who waits: red at once, medium within 45 min, low within 2 hours.
    # The fifth transport of a wave needs a wheelchair or stretcher and keeps V1 and V2 in use.
    priorities: list[Priority] = ["P3", "P2", "P1", "P2", "P3"]
    for wave, minute in enumerate(waves):
        requirements: list[Equipment] = ["OXYGEN", "OXYGEN", "OXYGEN", "OXYGEN",
                                         "STRETCHER" if wave % 2 else "WHEELCHAIR"]
        for lane, priority in enumerate(priorities):
            i = wave * len(priorities) + lane
            facility = facilities[lane % len(facilities)]
            earliest = (minute + lane * 2) * 60
            requests.append((f"T{i + 1:02}", NewTask(
                priority=priority,
                pickup=Point(lat=facility.location.lat + (lane % 3 - 1) * .006 + wave * .001,
                             lon=facility.location.lon + (-1) ** lane * (.012 + wave * .002)),
                pickup_name="Izbrana točka na zemljevidu", passenger_count=2 if i % 7 == 0 else 1,
                equipment=[requirements[lane]], earliest_pickup=earliest,
            ), earliest))
    return vehicles, facilities, demo_tasks(requests, facilities)


def oxygen_demo_data() -> tuple[list[Vehicle], list[Facility], list[Task]]:
    vehicles, facilities = demo_fleet()
    presentation_ids = {"V1": "V3", "V3": "V1"}
    for vehicle in vehicles:
        vehicle.id = presentation_ids.get(vehicle.id, vehicle.id)
        if vehicle.id == "V1":
            vehicle.equipment.append("VENTILATOR")
    low = NewTask(priority="P3", pickup=Point(lat=46.038, lon=14.554),
                  pickup_name="Prevzem na jugovzhodu Ljubljane", equipment=["VENTILATOR"])
    return vehicles, facilities, demo_tasks([(PRESENTATION_LOW, low, 300)], facilities)


def breakdown_demo_data() -> tuple[list[Vehicle], list[Facility], list[Task]]:
    _, facilities = demo_fleet()
    vehicles = [
        Vehicle(id=BREAKDOWN_VEHICLE, equipment=["OXYGEN", "WHEELCHAIR"], capacity=1,
                location=Point(lat=46.046, lon=14.494), available_at=BREAKDOWN_AT + 30,
                task_types=["PRIORITY_TRANSPORT", "EQUIPMENT_DELIVERY"]),
        Vehicle(id="V2", equipment=["OXYGEN"], capacity=1, location=Point(lat=46.078, lon=14.530),
                task_types=["PRIORITY_TRANSPORT", "EQUIPMENT_DELIVERY"]),
        Vehicle(id="V3", equipment=["WHEELCHAIR"], capacity=1, location=Point(lat=46.044, lon=14.537),
                task_types=["PRIORITY_TRANSPORT"]),
    ]
    requests = [
        (BREAKDOWN_OXYGEN, NewTask(priority="P2", equipment=["OXYGEN"],
            pickup=Point(lat=46.045, lon=14.496), pickup_name="Prevzem pri Trnovem"), 300),
        (BREAKDOWN_WHEELCHAIR, NewTask(priority="P2", equipment=["WHEELCHAIR"],
            pickup=Point(lat=46.041, lon=14.501), pickup_name="Prevzem pri Trnovskem mostu"), 1260),
        ("DEMO2-SEVER", NewTask(priority="P2", equipment=["OXYGEN"],
            pickup=Point(lat=46.075, lon=14.528), pickup_name="Prevzem na severu Ljubljane"), 180),
        ("DEMO2-VZHOD", NewTask(priority="P2", equipment=["WHEELCHAIR"],
            pickup=Point(lat=46.046, lon=14.538), pickup_name="Prevzem na vzhodu Ljubljane"), 180),
    ]
    return vehicles, facilities, demo_tasks(requests, facilities)


def demo_tasks(requests: list[tuple[str, NewTask, int]], facilities: list[Facility]) -> list[Task]:
    nodes = tuple(Node(task_id, "PICKUP", request.pickup) for task_id, request, _ in requests)
    travel = travel_snapshot(nodes + facility_nodes(facilities), 0, [], None)
    booked: Counter[str] = Counter()
    tasks = []
    for task_id, request, earliest in requests:
        task = priority_transport(task_id, request, earliest, facilities, booked, travel)
        if task is None:
            raise ValueError(f"Demo pickup {task_id} has no route to a facility")
        tasks.append(task)
        booked[task.facility_id] += 1
    return tasks
