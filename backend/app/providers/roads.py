import gzip
import json
from dataclasses import dataclass
from functools import lru_cache
from heapq import heappop, heappush
from math import ceil, cos, radians
from pathlib import Path
from unicodedata import combining, normalize

from app.planning.contracts import Incident, Node, Point, TravelMatrix, TravelSnapshot
from app.providers.haversine import local_snapshot

Coordinate = tuple[float, float]
Effects = tuple[frozenset[tuple[int, int]], tuple[tuple[tuple[int, int], float], ...]]
EXTRACT = Path(__file__).with_name("data") / "ljubljana.json.gz"
LONGITUDE_FACTOR = cos(radians(46))


def center_distance(a: Coordinate, b: Coordinate) -> float:
    return ((a[0] - b[0]) ** 2 + ((a[1] - b[1]) * LONGITUDE_FACTOR) ** 2) ** .5


def edge_key(a: int, b: int) -> tuple[int, int]:
    return min(a, b), max(a, b)


def address_key(value: str) -> str:
    stripped = "".join(char for char in normalize("NFD", value.casefold()) if not combining(char))
    return " ".join(stripped.replace(",", " ").split())


@dataclass(frozen=True)
class Segment:
    id: str
    name: str
    chains: tuple[tuple[int, ...], ...]


class RoadNetwork:
    def __init__(self, extract: dict):
        self.timestamp = extract["timestamp"]
        self.bounds = tuple(extract["bounds"])
        self.points = [tuple(point) for point in extract["points"]]
        self.edges: list[list[tuple[int, float, float]]] = [[] for _ in self.points]
        self.ways = extract["ways"]
        neighbors = [set() for _ in self.points]
        for _, _, _, direction, speed, nodes in self.ways:
            for a, b in zip(nodes, nodes[1:]):
                neighbors[a].add(b)
                neighbors[b].add(a)
                kilometers = center_distance(self.points[a], self.points[b]) * 111.2
                seconds = kilometers * 3600 / speed
                meters = kilometers * 1000
                if direction >= 0:
                    self.edges[a].append((b, seconds, meters))
                if direction <= 0:
                    self.edges[b].append((a, seconds, meters))
        self.neighbors = neighbors
        self.street_names = tuple(sorted({way[2] for way in self.ways if way[2]}))
        self.addresses = [(address_key(name), {"name": name, "lat": lat, "lon": lon})
                          for name, lat, lon in extract.get("addresses", ())]

    def find_addresses(self, query: str) -> list[dict]:
        key = address_key(query)
        if not key:
            return []
        matches = {}
        for normalized, address in self.addresses:
            if normalized == key:
                return [address]
            if normalized.startswith(key):
                matches.setdefault(address["name"], address)
        return list(matches.values())[:8]

    def segment_json(self, segment: Segment) -> dict:
        return {"id": segment.id, "name": segment.name,
                "paths": [[self.points[i] for i in chain] for chain in segment.chains]}

    @lru_cache(maxsize=1024)
    def segment(self, road_id: str) -> Segment | None:
        prefix, _, name = road_id.partition(":")
        if prefix == "street" and name in self.street_names:
            chains = tuple(tuple(way[5]) for way in self.ways if way[2] == name and len(way[5]) > 1)
            return Segment(road_id, name, chains) if chains else None
        if prefix != "way":
            return None
        try:
            way_index_text, edge_index_text = name.split(":", 1)
            way_index, edge_index = int(way_index_text), int(edge_index_text)
            if way_index < 0:
                return None
            way = self.ways[way_index]
        except (ValueError, IndexError):
            return None
        nodes = way[5]
        if edge_index < 0 or edge_index >= len(nodes) - 1:
            return None
        lower = edge_index
        while lower > 0 and len(self.neighbors[nodes[lower]]) == 2:
            lower -= 1
        upper = edge_index + 1
        while upper < len(nodes) - 1 and len(self.neighbors[nodes[upper]]) == 2:
            upper += 1
        chain = tuple(nodes[lower:upper + 1])
        return Segment(road_id, way[2] or "Neimenovana cesta", (chain,))

    def streets(self) -> list[str]:
        return list(self.street_names)

    def nearest(self, lat: float, lon: float) -> Segment | None:
        south, west, north, east = self.bounds
        if not (south <= lat <= north and west <= lon <= east):
            return None
        scale = 111_200
        cosine = cos(radians(lat))
        closest_named: tuple[float, int, int] | None = None
        closest_any: tuple[float, int, int] | None = None
        for way_index, way in enumerate(self.ways):
            nodes = way[5]
            for edge_index, (a, b) in enumerate(zip(nodes, nodes[1:])):
                start, end = self.points[a], self.points[b]
                dx = (end[1] - start[1]) * scale * cosine
                dy = (end[0] - start[0]) * scale
                px = (lon - start[1]) * scale * cosine
                py = (lat - start[0]) * scale
                squared_length = dx * dx + dy * dy
                fraction = max(0, min(1, (px * dx + py * dy) / squared_length)) if squared_length else 0
                offset = ((px - dx * fraction) ** 2 + (py - dy * fraction) ** 2) ** .5
                candidate = (offset, way_index, edge_index)
                if closest_any is None or offset < closest_any[0]:
                    closest_any = candidate
                if way[2] and (closest_named is None or offset < closest_named[0]):
                    closest_named = candidate
        nearest = closest_named if closest_named and closest_named[0] <= 500 else closest_any
        if nearest is None:
            return None
        _, way_index, edge_index = nearest
        return self.segment(f"way:{way_index}:{edge_index}")

    @lru_cache(maxsize=1)
    def basemap(self) -> bytes:
        paths = {i: [] for i in range(4)}
        for _, rank, _, _, _, nodes in self.ways:
            paths[rank].append([self.points[node] for node in nodes])
        return json.dumps({"bounds": self.bounds, "layers": [
            {"rank": rank, "paths": lines} for rank, lines in paths.items()
        ], "streets": self.streets(),
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
            segment = self.segment(event.road_id) if event.road_id else None
            if not segment:
                continue
            for chain in segment.chains:
                for a, b in zip(chain, chain[1:]):
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
        distances = [0.0] * len(self.points)
        previous = [-1] * len(self.points)
        costs[origin] = 0.0
        queue = [(0.0, origin)]
        while queue:
            score, source = heappop(queue)
            if score != costs[source]:
                continue
            for target, seconds, meters in self.edges[source]:
                key = edge_key(source, target)
                if key in closed:
                    continue
                estimate = score + seconds * delays.get(key, 1.0)
                if estimate < costs[target]:
                    costs[target], previous[target] = estimate, source
                    distances[target] = distances[source] + meters
                    heappush(queue, (estimate, target))
        return costs, previous, distances

    def road_path(self, a: Point, b: Point, effects: Effects) -> list[Coordinate]:
        origin, target = self.snap((a.lat, a.lon)), self.snap((b.lat, b.lon))
        if origin is None or target is None:
            return []
        costs, previous, _ = self._search(origin, effects)
        if costs[target] == float("inf"):
            return []
        path = [self.points[target]]
        while target != origin:
            target = previous[target]
            path.append(self.points[target])
        return list(reversed(path))

    def route(self, origin: Coordinate, target: Point, effects: Effects) -> tuple[int, list[Coordinate]] | None:
        start = self.snap(origin)
        end = self.snap((target.lat, target.lon))
        if start is None or end is None:
            return None
        costs, previous, _ = self._search(start, effects)
        if costs[end] == float("inf"):
            return None
        path = [self.points[end]]
        while end != start:
            end = previous[end]
            path.append(self.points[end])
        path.reverse()
        if path[0] != origin:
            path.insert(0, origin)
        destination = (target.lat, target.lon)
        if path[-1] != destination:
            path.append(destination)
        return ceil(costs[self.snap((target.lat, target.lon))]), path

    def snapshot(self, nodes: tuple[Node, ...], incidents: list[Incident]) -> TravelSnapshot:
        effects = self.effects(incidents)
        legacy = [i for i in incidents if not i.road_id]
        positions = tuple((node.point.lat, node.point.lon) for node in nodes)
        durations, distances = self._matrix(positions, effects)
        # Existing saved area incidents and weather retain their established semantics.
        if legacy:
            old_default = local_snapshot(nodes, [])
            old_incidents = local_snapshot(nodes, legacy)
            durations = tuple(tuple(
                None if value is None or adjusted is None else ceil(value * adjusted / default) if default else value
                for value, adjusted, default in zip(row, legacy_row, default_row)
            ) for row, legacy_row, default_row in zip(durations, old_incidents.durations, old_default.durations))
            distances = tuple(tuple(
                meters if seconds is not None else None
                for meters, seconds in zip(distance_row, time_row, strict=True)
            ) for distance_row, time_row in zip(distances, durations, strict=True))
        return TravelSnapshot(nodes, {node.id: i for i, node in enumerate(nodes)}, durations, "OSM_LJUBLJANA", distances)

    @lru_cache(maxsize=24)
    def _matrix(self, positions: tuple[Coordinate, ...], effects: Effects) -> tuple[TravelMatrix, TravelMatrix]:
        targets = [self.snap(point) for point in positions]
        durations, distances = [], []
        for i, source in enumerate(targets):
            costs, _, lengths = self._search(source, effects) if source is not None else ([], [], [])
            time_row, distance_row = [], []
            for j, target in enumerate(targets):
                if i == j:
                    time_row.append(0)
                    distance_row.append(0)
                elif costs and target is not None and costs[target] != float("inf"):
                    time_row.append(ceil(costs[target]))
                    distance_row.append(ceil(lengths[target]))
                else:
                    time_row.append(None)
                    distance_row.append(None)
            durations.append(tuple(time_row))
            distances.append(tuple(distance_row))
        return tuple(durations), tuple(distances)


@lru_cache(maxsize=1)
def road_network() -> RoadNetwork:
    with gzip.open(EXTRACT, "rt", encoding="utf-8") as raw:
        return RoadNetwork(json.load(raw))


def active_conditions(now: int, incidents: list[Incident]) -> list[Incident]:
    return [event for event in incidents if event.type in ("ROAD_CLOSURE", "TRAFFIC_DELAY", "WEATHER_DELAY")
            and event.occurred_at <= now and (event.ended_at is None or now < event.ended_at)
            and (event.duration is None or now < event.occurred_at + event.duration)]
