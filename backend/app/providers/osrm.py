from json import loads
from math import ceil, isfinite

import httpx

from app.planning.contracts import Node, TravelSnapshot
from app.providers.http import fetch


def parse_table(nodes: tuple[Node, ...], content: bytes) -> TravelSnapshot:
    data = loads(content)
    if not isinstance(data, dict) or data.get("code") != "Ok":
        raise ValueError("OSRM did not return a matrix")
    values = data.get("durations")
    if not isinstance(values, list) or any(not isinstance(row, list) for row in values):
        raise ValueError("Missing OSRM duration matrix")
    durations = []
    for row in values:
        if any(value is not None and (type(value) not in (float, int) or not isfinite(value) or value < 0)
               for value in row):
            raise ValueError("Invalid OSRM duration")
        durations.append(tuple(ceil(value) if value is not None else None for value in row))
    return TravelSnapshot(nodes, {node.id: i for i, node in enumerate(nodes)}, tuple(durations), "OSRM")


def road_snapshot(client: httpx.Client, base_url: str, nodes: tuple[Node, ...]) -> TravelSnapshot:
    coordinates = ";".join(f"{node.point.lon:.6f},{node.point.lat:.6f}" for node in nodes)
    content = fetch(client, f"{base_url.rstrip('/')}/table/v1/driving/{coordinates}",
                    params={"annotations": "duration"})
    return parse_table(nodes, content)
