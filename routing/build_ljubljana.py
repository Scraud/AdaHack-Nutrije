"""Build the local road extract from an Overpass 'out geom' response."""
import argparse
import gzip
import json
from pathlib import Path

BOUNDS = (46.014, 14.437, 46.110, 14.603)
CLASSES = {
    "motorway": (0, 75), "trunk": (0, 55), "primary": (1, 42), "secondary": (1, 36),
    "tertiary": (2, 32), "unclassified": (3, 28), "residential": (3, 25),
    "living_street": (3, 15), "service": (3, 18),
}


def build(document):
    south, west, north, east = BOUNDS
    by_id = {}
    points = []
    ways = []
    addresses = set()
    for entry in sorted(document["elements"], key=lambda item: item["id"]):
        tags = entry.get("tags", {})
        street, number = tags.get("addr:street"), tags.get("addr:housenumber")
        if street and number:
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
    return {"bounds": BOUNDS, "timestamp": document["osm3s"]["timestamp_osm_base"], "points": points,
            "ways": ways, "addresses": sorted(addresses)}


def pbf_document(source: Path):
    import osmium

    class Extract(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.points = {}
            self.elements = []

        def node(self, node):
            lat, lon = node.location.lat, node.location.lon
            south, west, north, east = BOUNDS
            if south <= lat <= north and west <= lon <= east:
                self.points[node.id] = {"lat": lat, "lon": lon}
                if node.tags.get("addr:street") and node.tags.get("addr:housenumber"):
                    self.elements.append({"id": node.id, "tags": dict(node.tags), "lat": lat, "lon": lon})

        def way(self, way):
            road = way.tags.get("highway", "").removesuffix("_link") in CLASSES
            address = way.tags.get("addr:street") and way.tags.get("addr:housenumber")
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


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("source", type=Path)
    cli.add_argument("destination", type=Path)
    args = cli.parse_args()
    data = build(pbf_document(args.source) if args.source.suffix == ".pbf"
                 else json.loads(args.source.read_text(encoding="utf-8")))
    args.destination.parent.mkdir(parents=True, exist_ok=True)
    args.destination.write_bytes(gzip.compress(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode(), mtime=0))
    print(f"{len(data['points'])} points, {len(data['ways'])} ways, {args.destination.stat().st_size} bytes")
