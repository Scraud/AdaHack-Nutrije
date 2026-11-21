from math import asin, ceil, cos, radians, sin, sqrt

from app.planning.contracts import Incident, Node, Point, TravelSnapshot

ROAD_FACTOR = 1.3
SPEED_KMH = 34


def distance_km(origin: Point, target: Point) -> float:
    dlat = radians(target.lat - origin.lat)
    dlon = radians(target.lon - origin.lon)
    a = sin(dlat / 2) ** 2 + cos(radians(origin.lat)) * cos(radians(target.lat)) * sin(dlon / 2) ** 2
    return 6371 * 2 * asin(sqrt(min(1, max(0, a))))


def crosses_area(origin: Point, target: Point, center: Point, radius: float) -> bool:
    if origin == target:
        return False
    # Project a short Ljubljana-area segment onto a local tangent plane.
    scale = cos(radians(center.lat)) * 111.2
    x, y = (origin.lon - center.lon) * scale, (origin.lat - center.lat) * 111.2
    dx, dy = (target.lon - origin.lon) * scale, (target.lat - origin.lat) * 111.2
    fraction = max(0, min(1, -(x * dx + y * dy) / (dx * dx + dy * dy)))
    return (x + fraction * dx) ** 2 + (y + fraction * dy) ** 2 <= radius ** 2


def simulated_duration(origin: Point, target: Point, seconds: float | None,
                       conditions: list[Incident]) -> int | None:
    if seconds is None:
        return None
    for event in conditions:
        if event.location is None or not crosses_area(origin, target, event.location, event.radius_km):
            continue
        if event.type == "ROAD_CLOSURE":
            return None
        seconds *= event.multiplier
    return ceil(seconds)


def local_snapshot(nodes: tuple[Node, ...], conditions: list[Incident]) -> TravelSnapshot:
    def duration(origin: Point, target: Point) -> int | None:
        seconds = distance_km(origin, target) * ROAD_FACTOR / SPEED_KMH * 3600
        return simulated_duration(origin, target, seconds, conditions)

    return TravelSnapshot(nodes, {node.id: i for i, node in enumerate(nodes)},
                          tuple(tuple(duration(a.point, b.point) for b in nodes) for a in nodes),
                          "HAVERSINE")
