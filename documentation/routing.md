# Routing — Road Network and Travel Matrices

RescueFlow needs travel times and paths between arbitrary GPS points in Ljubljana. It has two routing backends: a built-in graph derived from OpenStreetMap (always available) and an optional OSRM instance (more accurate, requires a separate process).

---

## Built-in OSM Graph — `providers/roads.py`

### Data File

`backend/app/providers/data/ljubljana.json.gz` is a compressed JSON extract of the Ljubljana road network, built from the Geofabrik Slovenia OSM extract using `routing/build_ljubljana.py`. It contains:

- `bounds` — `[south, west, north, east]` bounding box
- `timestamp` — OSM data replication timestamp
- `points` — list of `[lat, lon]` for all graph nodes
- `ways` — list of `[id, rank, street_name, direction, speed_kmh, [node_indices]]`

Speed values are approximated by road category (motorway, primary, secondary, etc.). Turn restrictions are not modelled.

### `RoadNetwork` class

Built once at startup via `road_network()` (cached with `@lru_cache`).

**Graph construction:** For each way, creates directed edges between consecutive node pairs. Reverse direction is added when `direction <= 0`. Each edge stores `(target_node, travel_seconds, meters)`.

**Snap to graph:** `snap(lat, lon)` finds the nearest graph node within 0.005 degrees (~500 m). Returns `None` if the point is outside bounds or too far from any node.

**Shortest path:** `_search(origin_node, effects)` runs a **Dijkstra** from one origin node. The `effects` tuple encodes:
- `closed` — a frozenset of edge keys `(min(a,b), max(a,b))` to skip (road closures)
- `delays` — a tuple of `((edge_key, multiplier), ...)` for traffic delays

This search is cached per `(origin, effects)` pair (`@lru_cache(maxsize=36)`).

**Travel matrix:** `_matrix(positions, effects)` calls `_search` once per origin node and reads off the cost to every destination. Returns a tuple-of-tuples `(durations, distances)`. Cached per `(positions, effects)` (`@lru_cache(maxsize=24)`).

**Path geometry:** `road_path(a, b, effects)` reconstructs the coordinate list by walking the `previous[]` back-pointer array from the Dijkstra result.

**Basemap:** `basemap()` serialises all road polylines by rank (rank 0 = motorways, rank 3 = residential) as a JSON blob for the frontend map layer. Cached forever.

**Named segments:** 5 specific road segments (Šmartinska, Dunajska, Celovška, Zaloška, Tržaška) are pre-extracted by name and exposed as `segments`. The frontend lets the dispatcher select one of these to trigger a road event.

### Effects of Incidents

`effects(incidents)` converts active `ROAD_CLOSURE` and `TRAFFIC_DELAY` incidents into the `Effects` tuple that the graph search uses. Only incidents whose `road_id` matches a named segment are applied.

`active_conditions(now, incidents)` filters the incident list to those currently in effect.

---

## OSRM — `providers/osrm.py`

OSRM (Open Source Routing Machine) is a production-grade routing engine that uses a preprocessed CH (Contraction Hierarchies) graph. It is more accurate than the built-in graph because it uses actual road speeds and considers one-way restrictions precisely.

### How it is used

`RoadMatrix(url)` wraps an OSRM instance. It has two caches:
- `_cached_matrices` — caches the full N×N table response per unique coordinate set
- `_cached_paths` — caches individual route geometries per (origin, target) pair

**Travel matrix** (`__call__`): calls `OSRM /table/v1/driving/{coords}` with `annotations=duration,distance`. Batches requests for more than 100 nodes (OSRM default limit is 100 per table).

**Path geometry** (`path(origin, target)`): calls `OSRM /route/v1/driving/{origin};{target}?geometries=geojson&overview=full` and extracts the full route geometry as `(lat, lon)` pairs.

If OSRM is unreachable, it raises `RoadRoutingUnavailable`, which the backend translates to a `503` HTTP response.

### Which backend is used?

The choice is made when a plan is generated:
- If `RESCUEFLOW_OSRM_URL` is set and reachable → `OSRM` (stored as `travel_source = "OSRM"`)
- Otherwise → `OSM_LJUBLJANA` (built-in graph)

The choice is **locked into the plan snapshot**. When the tracking view later needs to draw paths, it uses whichever backend was used when the plan was solved, so the displayed route matches the planned one.

---

## Haversine Fallback — `providers/haversine.py`

Before the full OSM graph was introduced, the system used Haversine (straight-line) distances with a road factor adjustment. Plans saved with `travel_source = "HAVERSINE"` still display using this provider so old plans remain consistent.

---

## Rebuilding the Road Data

To regenerate `ljubljana.json.gz` from a fresh OSM extract:

```sh
python -m pip install osmium
python routing/build_ljubljana.py routing/data/slovenia.osm.pbf \
    backend/app/providers/data/ljubljana.json.gz
```

Download `slovenia.osm.pbf` from [Geofabrik](https://download.geofabrik.de/europe/slovenia.html).

---

## Routing Summary

| Scenario | Travel Matrix | Path Geometry |
|---|---|---|
| No OSRM configured | Built-in Dijkstra on OSM graph | Same Dijkstra back-pointer walk |
| OSRM configured | OSRM `/table` endpoint | OSRM `/route` endpoint |
| Old plan (HAVERSINE) | Haversine with road factor | Haversine linear interpolation |
| Road closure active | Dijkstra skips closed edges | Same (closure reflected in paths) |
| Traffic delay active | Dijkstra multiplies edge cost | Path unchanged, just slower |
