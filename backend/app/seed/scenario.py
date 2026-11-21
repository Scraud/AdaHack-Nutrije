from app.planning.contracts import Equipment, Facility, Point, Priority, Task, Vehicle

DEMO_START = "2026-11-21T07:00:00Z"


def demo_data() -> tuple[list[Vehicle], list[Facility], list[Task]]:
    facilities = [
        Facility(id="F1", name="Center Trnovski most", location=Point(lat=46.038, lon=14.503), quota=8),
        Facility(id="F2", name="Center Zeleni gaj", location=Point(lat=46.066, lon=14.476), quota=8),
        Facility(id="F3", name="Center Severni park", location=Point(lat=46.084, lon=14.512), quota=8),
        Facility(id="F4", name="Center Vzhodni breg", location=Point(lat=46.051, lon=14.566), quota=8),
    ]
    equipment: list[list[Equipment]] = [
        ["WHEELCHAIR"], ["STRETCHER"], ["STRETCHER", "OXYGEN"],
        ["WHEELCHAIR", "STRETCHER", "OXYGEN"], ["WHEELCHAIR", "STRETCHER"],
    ]
    starts = [(46.046, 14.494), (46.067, 14.515), (46.078, 14.530), (46.044, 14.551), (46.054, 14.477)]
    vehicles = [
        Vehicle(id=f"V{i + 1}", equipment=equipment[i], capacity=1 if i in (1, 2) else 2,
                location=Point(lat=lat, lon=lon),
                task_types=["PLANNED_TRANSPORT", "PRIORITY_TRANSPORT", "EQUIPMENT_DELIVERY"])
        for i, (lat, lon) in enumerate(starts)
    ]
    tasks = []
    windows = (22, 102, 221, 315, 432)
    requirements: list[Equipment] = ["WHEELCHAIR", "STRETCHER", "OXYGEN", "STRETCHER"]
    priorities: list[Priority] = ["P3", "P2", "P1", "P2"]
    for wave, minute in enumerate(windows):
        for lane, facility in enumerate(facilities):
            i = wave * len(facilities) + lane
            start = (minute + lane * 4) * 60
            tasks.append(Task(
                id=f"T{i + 1:02}", type="PLANNED_TRANSPORT", priority=priorities[lane],
                pickup=Point(lat=facility.location.lat + (lane - 1) * .006 + wave * .001,
                             lon=facility.location.lon + (-1) ** lane * (.012 + wave * .002)),
                facility_id=facility.id, passenger_count=2 if i % 7 == 0 else 1,
                equipment=[requirements[lane]], earliest_pickup=start, latest_pickup=start + 1800,
                preferred_arrival=start + 1080, latest_arrival=start + 3150,
            ))
    return vehicles, facilities, tasks
