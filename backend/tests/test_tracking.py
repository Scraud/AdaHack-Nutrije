from datetime import UTC, datetime, timedelta
from math import ceil

from fastapi.testclient import TestClient

from app.main import create_app
from app.planning.contracts import Incident, Node, Point
from app.providers.roads import center_distance, edge_key, road_network
from app.services.tracking import position_on_path


def test_road_closure_excludes_the_exact_edges():
    network = road_network()
    segment = network.segment(f"street:{network.streets()[0]}")
    assert segment is not None
    event = Incident(type="ROAD_CLOSURE", road_id=segment.id)
    closed, delays = network.effects([event])
    assert closed == {tuple(sorted((a, b))) for chain in segment.chains for a, b in zip(chain, chain[1:])}
    assert not delays
    origin = segment.chains[0][0]
    target = segment.chains[0][-1]
    def point(i):
        return Point(lat=network.points[i][0], lon=network.points[i][1])

    path = network.road_path(point(origin), point(target), network.effects([]))
    if not path:
        origin, target = target, origin
        path = network.road_path(point(origin), point(target), network.effects([]))
    assert len(path) > 1
    alternate = network.road_path(point(origin), point(target), network.effects([event]))
    assert path != alternate
    route = network.route((network.points[origin][0], network.points[origin][1]), point(target), network.effects([]))
    assert route is not None and route[0] > 0 and route[1][-1] == (point(target).lat, point(target).lon)
    nodes = (Node("start", "VEHICLE_START", point(origin)), Node("end", "PICKUP", point(target)))
    matrix = network.snapshot(nodes, [])
    assert matrix.meters("start", "end") == ceil(sum(center_distance(a, b) * 111.2 * 1000
                                                     for a, b in zip(path, path[1:])))
    traffic = Incident(type="TRAFFIC_DELAY", road_id=segment.id, multiplier=2.3)
    traffic_closed, traffic_costs = network.effects([traffic])
    assert not traffic_closed
    assert dict(traffic_costs) == {edge: 2.3 for edge in closed}


def test_tracking_positions_and_incident_overlay_follow_simulation(tmp_path):
    with TestClient(create_app(tmp_path / "tracking.sqlite")) as client:
        roads = client.get("/api/map/roads").json()
        assert roads["streets"] and len(roads["layers"]) == 4
        street = roads["streets"][0]
        selected = client.get("/api/map/roads/street", params={"name": street}).json()
        assert selected["id"] == f"street:{street}" and selected["paths"]
        nearest = client.get("/api/map/roads/nearest", params={"lat": selected["paths"][0][0][0],
                                                                  "lon": selected["paths"][0][0][1]}).json()
        assert nearest["id"].startswith("way:") and nearest["paths"]
        state = client.post("/api/plans/generate").json()
        assert state["travel_source"] == "OSM_LJUBLJANA"
        assert state["active_plan"]["metrics"]["distance_meters"] > 0
        assignment = min((row for row in state["active_plan"]["assignments"] if row["deadhead"] > 5),
                         key=lambda row: row["planned_departure"])
        vehicle_id = assignment["vehicle_id"]

        def tracked():
            return next(row for row in client.get("/api/tracking").json()["vehicles"] if row["id"] == vehicle_id)

        first = tracked()
        assert len(first["to_pickup"]) > 2 and len(first["to_hospital"]) > 2
        assert first["eta"] == {"destination": "PICKUP", "seconds": assignment["planned_pickup"]}
        instant = assignment["planned_departure"] + assignment["deadhead"] // 2
        assert client.post("/api/demo/advance-time", json={"to": instant}).is_success
        moving = tracked()
        assert moving["location"] != first["location"] and moving["status"] == "TO_PICKUP"
        assert moving["eta"] == {"destination": "PICKUP", "seconds": assignment["planned_pickup"] - instant}
        pickup = assignment["planned_pickup"]
        dropoff = assignment["planned_dropoff"]
        assert client.post("/api/demo/advance-time", json={"to": pickup}).is_success
        assert tracked()["eta"] == {"destination": "HOSPITAL", "seconds": dropoff - pickup}
        task = next(row for row in state["tasks"] if row["id"] == assignment["task_id"])
        instant = pickup + task["pickup_service"]
        assert client.post("/api/demo/advance-time", json={"to": instant}).is_success
        assert tracked()["status"] == "TO_HOSPITAL"
        assert tracked()["eta"] == {"destination": "HOSPITAL", "seconds": dropoff - instant}
        assert client.post("/api/demo/advance-time", json={"to": dropoff}).is_success
        assert tracked()["eta"] is None
        closure = client.post("/api/incidents", json={"type": "ROAD_CLOSURE", "road_id": selected["id"]})
        assert closure.is_success
        overlay = client.get("/api/tracking").json()["incidents"][0]
        assert overlay["road_id"] == selected["id"] and overlay["name"] == street and overlay["paths"]
        resolved = client.post(f"/api/incidents/{overlay['id']}/resolve")
        assert resolved.is_success
        assert resolved.json()["incidents"][-1]["ended_at"] == resolved.json()["now"]
        assert client.get("/api/tracking").json()["incidents"] == []
        assert client.post(f"/api/incidents/{overlay['id']}/resolve").status_code == 409


def test_road_closure_automatically_reroutes_active_vehicle(tmp_path):
    network = road_network()
    with TestClient(create_app(tmp_path / "reroute.sqlite")) as client:
        state = client.post("/api/plans/generate").json()
        assignment = min((row for row in state["active_plan"]["assignments"] if row["deadhead"] > 5),
                         key=lambda row: row["planned_departure"])
        task = next(row for row in state["tasks"] if row["id"] == assignment["task_id"])
        point = Point.model_validate(task["pickup"])
        instant = assignment["planned_departure"] + assignment["deadhead"] // 2
        assert client.post("/api/demo/advance-time", json={"to": instant}).is_success
        vehicle = next(row for row in client.get("/api/tracking").json()["vehicles"]
                       if row["id"] == assignment["vehicle_id"])
        assert vehicle["status"] == "TO_PICKUP"
        old_path = vehicle["to_pickup"]
        closest = min(range(len(old_path)), key=lambda index: center_distance(old_path[index], vehicle["location"]))
        old_edges = {edge_key(network.snap(tuple(old_path[index])), network.snap(tuple(old_path[index + 1])))
                     for index in range(closest, len(old_path) - 1)}

        closure = None
        for index in range(closest + 1, len(old_path) - 1):
            a, b = old_path[index], old_path[index + 1]
            segment = network.nearest((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
            if segment is None:
                continue
            event = Incident(type="ROAD_CLOSURE", road_id=segment.id)
            closed, _ = network.effects([event])
            if not old_edges.intersection(closed):
                continue
            detour = network.road_path(Point.model_validate({"lat": vehicle["location"][0],
                                                              "lon": vehicle["location"][1]}), point, (closed, ()))
            if detour and len(detour) > 1:
                closure = event
                break
        assert closure is not None, "expected to find a closable edge with an alternate route"

        created = client.post("/api/incidents", json=closure.model_dump(exclude={"id", "occurred_at"}))
        assert created.is_success
        tracked = next(row for row in client.get("/api/tracking").json()["vehicles"]
                       if row["id"] == assignment["vehicle_id"])
        assert tracked["status"] == "TO_PICKUP"
        closed, _ = network.effects([closure])
        rerouted_edges = {edge_key(network.snap(tuple(a)), network.snap(tuple(b)))
                          for a, b in zip(tracked["to_pickup"], tracked["to_pickup"][1:])
                          if network.snap(tuple(a)) is not None and network.snap(tuple(b)) is not None}
        assert not rerouted_edges.intersection(closed)
        assert tracked["location"] != vehicle["location"] or tracked["to_pickup"] != old_path

        rerouted_assignment = next(row for row in created.json()["active_plan"]["assignments"]
                                   if row["task_id"] == assignment["task_id"])
        assert rerouted_assignment["vehicle_id"] == assignment["vehicle_id"]
        assert client.post("/api/demo/advance-time", json={"to": rerouted_assignment["planned_pickup"]}).is_success
        state = client.get("/api/state").json()
        actual_task = next(row for row in state["tasks"] if row["id"] == assignment["task_id"])
        assert actual_task["actual_pickup"] == rerouted_assignment["planned_pickup"]

        incident_id = created.json()["incidents"][-1]["id"]
        resolved = client.post(f"/api/incidents/{incident_id}/resolve")
        assert resolved.is_success
        after_resolve = next(row for row in client.get("/api/tracking").json()["vehicles"]
                             if row["id"] == assignment["vehicle_id"])
        assert after_resolve["status"] != "STOPPED"

        pickup_end = rerouted_assignment["planned_pickup"] + task["pickup_service"]
        assert client.post("/api/demo/advance-time", json={"to": pickup_end}).is_success
        loaded_vehicle = next(row for row in client.get("/api/tracking").json()["vehicles"]
                              if row["id"] == assignment["vehicle_id"])
        assert loaded_vehicle["status"] == "TO_HOSPITAL"
        facility = next(row for row in state["facilities"] if row["id"] == task["facility_id"])
        hospital = Point.model_validate(facility["location"])
        closest = min(range(len(loaded_vehicle["to_hospital"])),
                      key=lambda index: center_distance(loaded_vehicle["to_hospital"][index],
                                                        loaded_vehicle["location"]))
        hospital_closure = None
        for index in range(closest + 1, len(loaded_vehicle["to_hospital"]) - 1):
            a, b = loaded_vehicle["to_hospital"][index:index + 2]
            segment = network.nearest((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
            if segment is None:
                continue
            event = Incident(type="ROAD_CLOSURE", road_id=segment.id)
            closed, _ = network.effects([event])
            detour = network.road_path(
                Point(lat=loaded_vehicle["location"][0], lon=loaded_vehicle["location"][1]), hospital,
                (closed, ()))
            if detour and len(detour) > 1:
                hospital_closure = event
                break
        assert hospital_closure is not None, "expected an alternate route to the hospital"
        hospital_incident = client.post("/api/incidents", json={"type": "ROAD_CLOSURE",
                                                                  "road_id": hospital_closure.road_id})
        assert hospital_incident.is_success
        loaded_detour = next(row for row in client.get("/api/tracking").json()["vehicles"]
                             if row["id"] == assignment["vehicle_id"])
        assert loaded_detour["status"] == "TO_HOSPITAL"
        closed, _ = network.effects([hospital_closure])
        loaded_edges = {edge_key(network.snap(tuple(a)), network.snap(tuple(b)))
                        for a, b in zip(loaded_detour["to_hospital"], loaded_detour["to_hospital"][1:])
                        if network.snap(tuple(a)) is not None and network.snap(tuple(b)) is not None}
        assert not loaded_edges.intersection(closed)
        hospital_incident_id = hospital_incident.json()["incidents"][-1]["id"]
        assert client.post(f"/api/incidents/{hospital_incident_id}/resolve").is_success
        assert next(row for row in client.get("/api/tracking").json()["vehicles"]
                    if row["id"] == assignment["vehicle_id"])["status"] == "TO_HOSPITAL"


def test_position_interpolates_by_distance_and_keeps_corners():
    road = [(46.0, 14.0), (46.001, 14.0), (46.002, 14.0), (46.002, 14.001)]
    fallback = Point(lat=46, lon=14)
    halfway = position_on_path(road, .5, fallback)
    assert halfway[1] == 14.0
    assert 46.001 < halfway[0] < 46.002
    assert position_on_path(road, 2, fallback) == road[-1]


def test_main_traffic_factor_delays_hospital_arrival_and_tracking_eta(tmp_path):
    network = road_network()
    with TestClient(create_app(tmp_path / "traffic-eta.sqlite")) as client:
        state = client.post("/api/plans/generate").json()
        assignment = min(state["active_plan"]["assignments"], key=lambda row: row["planned_departure"])
        task = next(row for row in state["tasks"] if row["id"] == assignment["task_id"])
        instant = assignment["planned_pickup"] + task["pickup_service"]
        assert client.post("/api/demo/advance-time", json={"to": instant}).is_success
        vehicle = next(row for row in client.get("/api/tracking").json()["vehicles"]
                       if row["id"] == assignment["vehicle_id"])
        assert vehicle["status"] == "TO_HOSPITAL"
        destination = Point.model_validate(next(f["location"] for f in state["facilities"]
                                                if f["id"] == task["facility_id"]))
        targets = {}
        for a, b in zip(vehicle["to_hospital"], vehicle["to_hospital"][1:]):
            segment = network.nearest((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
            if segment:
                road_id = f"street:{segment.name}"
                if network.segment(road_id):
                    event = Incident(type="TRAFFIC_DELAY", road_id=road_id, multiplier=2.3)
                    route = network.route(tuple(vehicle["location"]), destination, network.effects([event]))
                    if route:
                        targets[road_id] = route[0]
        road_id = max(targets, key=targets.get)
        assert targets[road_id] > vehicle["eta"]["seconds"], "Select a street affecting the current trip"
        response = client.post("/api/incidents", json={"type": "TRAFFIC_DELAY", "road_id": road_id,
                                                      "duration": 5400, "multiplier": 2.3})
        assert response.is_success, response.text
        updated = next(row for row in response.json()["active_plan"]["assignments"]
                       if row["task_id"] == assignment["task_id"])
        assert updated["planned_dropoff"] > assignment["planned_dropoff"]
        assert updated["vehicle_id"] == assignment["vehicle_id"]
        tracked = next(row for row in client.get("/api/tracking").json()["vehicles"]
                       if row["id"] == assignment["vehicle_id"])
        assert tracked["eta"]["seconds"] == updated["planned_dropoff"] - instant
        assert tracked["eta"]["seconds"] > vehicle["eta"]["seconds"]
        assert response.json()["incidents"][-1]["description"] == ""


def test_gps_requires_key_and_does_not_replace_simulated_dispatch_state(tmp_path, monkeypatch):
    monkeypatch.setenv("RESCUEFLOW_GPS_KEY", "test-only-key")
    with TestClient(create_app(tmp_path / "gps.sqlite")) as client:
        assert client.get("/api/tracking").json()["vehicles"] == []
        now = datetime.now(UTC)
        fix = {"vehicle_id": "V1", "location": {"lat": 46.04, "lon": 14.51}, "recorded_at": now.isoformat()}
        assert client.post("/api/tracking/gps", json=fix).status_code == 401
        headers = {"Authorization": "Bearer test-only-key"}
        assert client.post("/api/tracking/gps", json=fix, headers=headers).status_code == 204
        old = {**fix, "location": {"lat": 46.07, "lon": 14.57},
               "recorded_at": (now - timedelta(minutes=2)).isoformat()}
        assert client.post("/api/tracking/gps", json=old, headers=headers).status_code == 204
        frame = client.get("/api/tracking").json()
        assert frame["mode"] == "GPS" and frame["vehicles"][0]["location"] == [46.04, 14.51]
        assert frame["vehicles"][0]["to_pickup"] == []
        assert frame["vehicles"][0]["eta"] is None
        assert client.get("/api/state").json()["vehicles"][0]["location"] != fix["location"]
