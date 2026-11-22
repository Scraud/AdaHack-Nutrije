from collections.abc import Callable
from functools import lru_cache, partial
from json import loads
from math import ceil, isfinite

import httpx

from app.planning.contracts import Node, Point, TravelMatrix, TravelSnapshot
from app.providers.http import fetch


class RoadRoutingUnavailable(RuntimeError):
    pass


def parse_table(content: bytes, rows: int, columns: int) -> tuple[TravelMatrix, TravelMatrix]:
    data = loads(content)
    if not isinstance(data, dict) or data.get("code") != "Ok":
        raise ValueError("OSRM did not return a matrix")

    def read(name: str) -> TravelMatrix:
        matrix = data.get(name)
        if not isinstance(matrix, list) or len(matrix) != rows or any(
            not isinstance(row, list) or len(row) != columns for row in matrix
        ):
            raise ValueError(f"Invalid OSRM {name} matrix dimensions")
        if any(value is not None and (type(value) not in (float, int) or not isfinite(value) or value < 0)
               for row in matrix for value in row):
            raise ValueError(f"Invalid OSRM {name} value")
        return tuple(tuple(ceil(value) if value is not None else None for value in row) for row in matrix)

    durations, distances = read("durations"), read("distances")
    if any((duration is None) != (distance is None)
           for duration_row, distance_row in zip(durations, distances, strict=True)
           for duration, distance in zip(duration_row, distance_row, strict=True)):
        raise ValueError("OSRM distance and duration reachability differ")
    return durations, distances


def _table(client: httpx.Client, url: str, coordinates: tuple[str, ...],
           sources: tuple[str, ...], destinations: tuple[str, ...]) -> tuple[TravelMatrix, TravelMatrix]:
    indices = {coordinate: str(i) for i, coordinate in enumerate(coordinates)}
    # OSRM requires at least two coordinates, even for a one-cell matrix.
    path = ";".join(coordinates if len(coordinates) > 1 else coordinates * 2)
    params = {"annotations": "duration,distance"}
    if sources != coordinates or destinations != coordinates or len(coordinates) == 1:
        params["sources"] = ";".join(indices[point] for point in sources)
        params["destinations"] = ";".join(indices[point] for point in destinations)
    content = fetch(client, f"{url.rstrip('/')}/table/v1/driving/{path}", params=params)
    return parse_table(content, len(sources), len(destinations))


def _fetch_matrices(client: httpx.Client, url: str, coordinates: tuple[str, ...]) -> tuple[TravelMatrix, TravelMatrix]:
    if len(coordinates) <= 100:
        return _table(client, url, coordinates, coordinates, coordinates)

    # At most 100 unique coordinates per request with OSRM's default table settings.
    batches = [coordinates[index:index + 50] for index in range(0, len(coordinates), 50)]
    durations, distances = [], []
    for sources in batches:
        duration_rows = [[] for _ in sources]
        distance_rows = [[] for _ in sources]
        for destinations in batches:
            points = tuple(dict.fromkeys(sources + destinations))
            times, lengths = _table(client, url, points, sources, destinations)
            for index in range(len(sources)):
                duration_rows[index].extend(times[index])
                distance_rows[index].extend(lengths[index])
        durations.extend(map(tuple, duration_rows))
        distances.extend(map(tuple, distance_rows))
    return tuple(durations), tuple(distances)


def _snapshot(nodes: tuple[Node, ...],
              load: Callable[[tuple[str, ...]], tuple[TravelMatrix, TravelMatrix]]) -> TravelSnapshot:
    if not nodes:
        return TravelSnapshot((), {}, (), "OSRM", ())
    locations = tuple(coordinate_string(node.point) for node in nodes)
    coordinates = tuple(dict.fromkeys(locations))
    coordinate_indices = {point: i for i, point in enumerate(coordinates)}
    indices = [coordinate_indices[point] for point in locations]
    durations, distances = load(coordinates)

    def expand(matrix: TravelMatrix) -> TravelMatrix:
        return tuple(tuple(matrix[origin][destination] for destination in indices) for origin in indices)

    return TravelSnapshot(nodes, {node.id: i for i, node in enumerate(nodes)},
                          expand(durations), "OSRM", expand(distances))


def coordinate_string(point: Point) -> str:
    return f"{point.lon:.6f},{point.lat:.6f}"


def road_snapshot(client: httpx.Client, base_url: str, nodes: tuple[Node, ...]) -> TravelSnapshot:
    return _snapshot(nodes, partial(_fetch_matrices, client, base_url))


class RoadMatrix:
    def __init__(self, url: str):
        self.url = url
        self._cached_matrices = lru_cache(maxsize=8)(self._load_matrices)
        self._cached_paths = lru_cache(maxsize=160)(self._load_path)

    def __call__(self, nodes: tuple[Node, ...]) -> TravelSnapshot:
        try:
            return _snapshot(nodes, self._cached_matrices)
        except (httpx.HTTPError, httpx.InvalidURL, ValueError, OverflowError) as exc:
            raise RoadRoutingUnavailable() from exc

    def _load_matrices(self, coordinates: tuple[str, ...]) -> tuple[TravelMatrix, TravelMatrix]:
        with httpx.Client(timeout=3, trust_env=False) as client:
            return _fetch_matrices(client, self.url, coordinates)

    def path(self, origin: Point, target: Point) -> list[tuple[float, float]]:
        if origin == target:
            return [(origin.lat, origin.lon)]
        try:
            return list(self._cached_paths(coordinate_string(origin), coordinate_string(target)))
        except (httpx.HTTPError, httpx.InvalidURL, ValueError, TypeError, KeyError, IndexError):
            return []

    def _load_path(self, origin: str, target: str) -> tuple[tuple[float, float], ...]:
        with httpx.Client(timeout=3, trust_env=False) as client:
            data = loads(fetch(client, f"{self.url.rstrip('/')}/route/v1/driving/{origin};{target}",
                               params={"geometries": "geojson", "overview": "full"}))
        if data["code"] != "Ok":
            return ()
        coordinates = data["routes"][0]["geometry"]["coordinates"]
        points = (Point(lat=lat, lon=lon) for lon, lat in coordinates)
        return tuple((point.lat, point.lon) for point in points)
