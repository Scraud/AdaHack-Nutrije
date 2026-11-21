import gzip
import json
from dataclasses import dataclass
from functools import lru_cache
from heapq import heappop, heappush
from math import ceil, cos, radians
from pathlib import Path

from app.planning.contracts import Incident, Node, Point, TravelSnapshot
from app.providers.haversine import local_snapshot

Coordinate = tuple[float, float]
Effects = tuple[frozenset[tuple[int, int]], tuple[tuple[tuple[int, int], float], ...]]
EXTRACT = Path(__file__).with_name("data") / "ljubljana.json.gz"
LONGITUDE_FACTOR = cos(radians(46))
SEGMENT_TARGETS = (
    ("smartinska", "Šmartinska cesta", (46.0666, 14.5458)),
    ("dunajska", "Dunajska cesta", (46.077, 14.514)),
    ("celovska", "Celovška cesta", (46.073, 14.478)),
    ("zaloska", "Zaloška cesta", (46.054, 14.550)),
    ("trzaska", "Tržaška cesta", (46.039, 14.476)),
)


def center_distance(a: Coordinate, b: Coordinate) -> float:
    return ((a[0] - b[0]) ** 2 + ((a[1] - b[1]) * LONGITUDE_FACTOR) ** 2) ** .5


def edge_key(a: int, b: int) -> tuple[int, int]:
    return min(a, b), max(a, b)


@dataclass(frozen=True)
class Segment:
    id: str
    name: str
    vertices: tuple[int, ...]


class RoadNetwork:
    def __init__(self, extract: dict):
        self.timestamp = extract["timestamp"]
        self.bounds = tuple(extract["bounds"])
        self.points = [tuple(point) for point in extract["points"]]
        self.edges: list[list[tuple[int, float]]] = [[] for _ in self.points]
        self.ways = extract["ways"]
        for _, _, _, direction, speed, nodes in self.ways:
            for a, b in zip(nodes, nodes[1:]):
                seconds = center_distance(self.points[a], self.points[b]) * 111.2 * 3600 / speed
                if direction >= 0:
                    self.edges[a].append((b, seconds))
                if direction <= 0:
                    self.edges[b].append((a, seconds))
        self.segments = {}
        for key, name, center in SEGMENT_TARGETS:
            matches = [(center_distance(self.points[node], center), index, nodes)
                       for _, _, street, _, _, nodes in self.ways if street == name
                       for index, node in enumerate(nodes)]
            if matches:
                _, index, nodes = min(matches)
                lower, upper = max(0, index - 2), min(len(nodes), index + 3)
                self.segments[key] = Segment(key, name, tuple(nodes[lower:upper]))

    def segment_json(self, segment: Segment) -> dict:
        return {"id": segment.id, "name": segment.name, "path": [self.points[i] for i in segment.vertices]}

    @lru_cache(maxsize=1)
    def basemap(self) -> bytes:
        paths = {i: [] for i in range(4)}
        for _, rank, _, _, _, nodes in self.ways:
            paths[rank].append([self.points[node] for node in nodes])
        return json.dumps({"bounds": self.bounds, "layers": [
            {"rank": rank, "paths": lines} for rank, lines in paths.items()
        ], "segments": [self.segment_json(segment) for segment in self.segments.values()],
            "timestamp": self.timestamp}, separators=(",", ":")).encode()

    @lru_cache(maxsize=160)
    def snap(self, position: Coordinate) -> int | None:
        south, west, north, east = self.bounds
        if not (south <= position[0] <= north and west <= position[1] <= east):
            return None
        closest = min((i for i, edges in enumerate(self.edges) if edges),
                      key=lambda i: center_distance(self.points[i], position))
        return closest if center_distance(self.points[closest], position) < .005 else None

    def effects(self, incidents: list[Incident]) -> Effects:
        closed = set()
        delays: dict[tuple[int, int], float] = {}
        for event in incidents:
            segment = self.segments.get(event.road_id) if event.road_id else None
            if not segment:
                continue
            for a, b in zip(segment.vertices, segment.vertices[1:]):
                key = edge_key(a, b)
                if event.type == "ROAD_CLOSURE":
                    closed.add(key)
                elif event.type == "TRAFFIC_DELAY":
                    delays[key] = delays.get(key, 1.0) * event.multiplier
        return frozenset(closed), tuple(sorted(delays.items()))

    @lru_cache(maxsize=36)
    def _search(self, origin: int, effects: Effects):
        closed, delay_data = effects
        delays = dict(delay_data)
        costs = [float("inf")] * len(self.points)
        previous = [-1] * len(self.points)
        costs[origin] = 0.0
        queue = [(0.0, origin)]
        while queue:
            score, source = heappop(queue)
            if score != costs[source]:
                continue
            for target, seconds in self.edges[source]:
                key = edge_key(source, target)
                if key in closed:
                    continue
                estimate = score + seconds * delays.get(key, 1.0)
                if estimate < costs[target]:
                    costs[target], previous[target] = estimate, source
                    heappush(queue, (estimate, target))
        return costs, previous

    def road_path(self, a: Point, b: Point, effects: Effects) -> list[Coordinate]:
        origin, target = self.snap((a.lat, a.lon)), self.snap((b.lat, b.lon))
        if origin is None or target is None:
            return []
        costs, previous = self._search(origin, effects)
        if costs[target] == float("inf"):
            return []
        path = [self.points[target]]
        while target != origin:
            target = previous[target]
            path.append(self.points[target])
        return list(reversed(path))

    def snapshot(self, nodes: tuple[Node, ...], incidents: list[Incident]) -> TravelSnapshot:
        effects = self.effects(incidents)
        legacy = [i for i in incidents if not i.road_id]
        positions = tuple((node.point.lat, node.point.lon) for node in nodes)
        durations = self._matrix(positions, effects)
        # Existing saved area incidents and weather retain their established semantics.
        if legacy:
            old_default = local_snapshot(nodes, [])
            old_incidents = local_snapshot(nodes, legacy)
            durations = tuple(tuple(
                None if value is None or adjusted is None else ceil(value * adjusted / default) if default else value
                for value, adjusted, default in zip(row, legacy_row, default_row)
            ) for row, legacy_row, default_row in zip(durations, old_incidents.durations, old_default.durations))
        return TravelSnapshot(nodes, {node.id: i for i, node in enumerate(nodes)}, durations, "OSM_LJUBLJANA")

    @lru_cache(maxsize=24)
    def _matrix(self, positions: tuple[Coordinate, ...], effects: Effects):
        targets = [self.snap(point) for point in positions]
        rows = []
        for i, source in enumerate(targets):
            costs = self._search(source, effects)[0] if source is not None else None
            rows.append(tuple(
                0 if i == j else ceil(costs[target]) if costs is not None and target is not None
                and costs[target] != float("inf") else None
                for j, target in enumerate(targets)
            ))
        return tuple(rows)


@lru_cache(maxsize=1)
def road_network() -> RoadNetwork:
    with gzip.open(EXTRACT, "rt", encoding="utf-8") as raw:
        return RoadNetwork(json.load(raw))


def active_conditions(now: int, incidents: list[Incident]) -> list[Incident]:
    return [event for event in incidents if event.type in ("ROAD_CLOSURE", "TRAFFIC_DELAY", "WEATHER_DELAY")
            and event.occurred_at <= now and (event.duration is None or now < event.occurred_at + event.duration)]
