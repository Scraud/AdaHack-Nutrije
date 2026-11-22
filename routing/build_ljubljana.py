"""Build the local road extract or regional basemap from OSM data."""
import argparse
import gzip
import json
from pathlib import Path

BOUNDS = (46.014, 14.437, 46.110, 14.603)
REGIONAL_BOUNDS = (45.77, 14.18, 46.28, 14.87)
CLASSES = {
    "motorway": (0, 75), "trunk": (0, 55), "primary": (1, 42), "secondary": (1, 36),
    "tertiary": (2, 32), "unclassified": (3, 28), "residential": (3, 25),
    "living_street": (3, 15), "service": (3, 18),
}


def build(document, bounds=BOUNDS, *, include_addresses=True):
    south, west, north, east = bounds
    by_id = {}
    points = []
    ways = []
    addresses = set()
    for entry in sorted(document["elements"], key=lambda item: item["id"]):
        tags = entry.get("tags", {})
        street, number = tags.get("addr:street"), tags.get("addr:housenumber")
        if include_addresses and street and number:
            geometry = ([entry] if "lat" in entry else entry.get("geometry", ()))
            locations = [point for point in geometry if point is not None]
            if locations:
                lat = sum(point["lat"] for point in locations) / len(locations)
                lon = sum(point["lon"] for point in locations) / len(locations)
                if south <= lat <= north and west <= lon <= east:
                    addresses.add((f"{street} {number}", round(lat, 6), round(lon, 6)))
        road = tags.get("highway", "").removesuffix("_link")
        if road not in CLASSES or tags.get("area") == "yes":
            continue
        rank, speed = CLASSES[road]
        default_oneway = road == "motorway" or tags.get("junction") == "roundabout"
        one_way = tags.get("oneway")
        direction = -1 if one_way == "-1" else int(
            one_way in ("yes", "1", "true") or (one_way is None and default_oneway)
        )
        access = tags.get("motor_vehicle", tags.get("vehicle", tags.get("access")))
        if access in ("no", "private") or tags.get("service") in ("driveway", "parking_aisle"):
            continue
        route = []
        for node, location in zip(entry["nodes"], entry["geometry"], strict=True):
            if location is None or not (south <= location["lat"] <= north and west <= location["lon"] <= east):
                if len(route) >= 2:
                    ways.append([f'{entry["id"]}-{len(ways)}', rank, tags.get("name", ""), direction, speed, route])
                route = []
                continue
            lat, lon = location["lat"], location["lon"]
            if node not in by_id:
                by_id[node] = len(points)
                points.append([round(lat, 6), round(lon, 6)])
            route.append(by_id[node])
        if len(route) >= 2:
            ways.append([f'{entry["id"]}-{len(ways)}', rank, tags.get("name", ""), direction, speed, route])
    return {"bounds": bounds, "timestamp": document["osm3s"]["timestamp_osm_base"], "points": points,
            "ways": ways, "addresses": sorted(addresses)}


def pbf_document(source: Path, bounds=BOUNDS, *, include_addresses=True):
    import osmium

    south, west, north, east = bounds

    class Extract(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.points = {}
            self.elements = []

        def node(self, node):
            lat, lon = node.location.lat, node.location.lon
            if south <= lat <= north and west <= lon <= east:
                self.points[node.id] = {"lat": lat, "lon": lon}
                if include_addresses and node.tags.get("addr:street") and node.tags.get("addr:housenumber"):
                    self.elements.append({"id": node.id, "tags": dict(node.tags), "lat": lat, "lon": lon})

        def way(self, way):
            road = way.tags.get("highway", "").removesuffix("_link") in CLASSES
            address = include_addresses and way.tags.get("addr:street") and way.tags.get("addr:housenumber")
            if not road and not address:
                return
            nodes = [node.ref for node in way.nodes]
            geometry = [self.points.get(node) for node in nodes]
            if sum(point is not None for point in geometry) >= 2:
                self.elements.append({"id": way.id, "tags": dict(way.tags), "nodes": nodes, "geometry": geometry})

    with osmium.io.Reader(str(source)) as reader:
        timestamp = reader.header().get("osmosis_replication_timestamp")
    osm = Extract()
    osm.apply_file(str(source))
    return {"elements": osm.elements, "osm3s": {"timestamp_osm_base": timestamp}}


def basemap(extract):
    paths = {rank: [] for rank in range(4)}
    for _, rank, _, _, _, nodes in extract["ways"]:
        paths[rank].append([extract["points"][node] for node in nodes])
    return {"bounds": extract["bounds"], "timestamp": extract["timestamp"], "streets": [],
            "layers": [{"rank": rank, "paths": lines} for rank, lines in paths.items()]}


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("source", type=Path)
    cli.add_argument("destination", type=Path)
    cli.add_argument("--regional-map", action="store_true", help="Write the wider basemap for the fleet dashboard.")
    args = cli.parse_args()
    bounds = REGIONAL_BOUNDS if args.regional_map else BOUNDS
    include_addresses = not args.regional_map
    document = (pbf_document(args.source, bounds, include_addresses=include_addresses)
                if args.source.suffix == ".pbf" else json.loads(args.source.read_text(encoding="utf-8")))
    extract = build(document, bounds, include_addresses=include_addresses)
    data = basemap(extract) if args.regional_map else extract
    args.destination.parent.mkdir(parents=True, exist_ok=True)
    args.destination.write_bytes(gzip.compress(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode(), mtime=0))
    print(f"{len(extract['points'])} points, {len(extract['ways'])} ways, {args.destination.stat().st_size} bytes")
