from datetime import UTC, datetime, timedelta
from math import ceil

from fastapi.testclient import TestClient

from app.main import create_app
from app.planning.contracts import Incident, Node, Point
from app.providers.roads import center_distance, road_network
from app.services.tracking import position_on_path


def test_road_closure_excludes_the_exact_edges():
    network = road_network()
    segment = network.segments["dunajska"]
    event = Incident(type="ROAD_CLOSURE", road_id=segment.id)
    closed, delays = network.effects([event])
    assert closed == {tuple(sorted((a, b))) for a, b in zip(segment.vertices, segment.vertices[1:])}
    assert not delays
    origin = segment.vertices[0]
    target = segment.vertices[-1]
    def point(i):
        return Point(lat=network.points[i][0], lon=network.points[i][1])

    path = network.road_path(point(origin), point(target), network.effects([]))
    if not path:
        origin, target = target, origin
        path = network.road_path(point(origin), point(target), network.effects([]))
    assert len(path) > 1
    alternate = network.road_path(point(origin), point(target), network.effects([event]))
    assert path != alternate
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
        assert roads["segments"] and len(roads["layers"]) == 4
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
        instant = assignment["planned_departure"] + assignment["deadhead"] // 2
        assert client.post("/api/demo/advance-time", json={"to": instant}).is_success
        moving = tracked()
        assert moving["location"] != first["location"] and moving["status"] == "TO_PICKUP"
        assert client.post("/api/incidents", json={"type": "ROAD_CLOSURE", "road_id": "dunajska"}).is_success
        assert client.get("/api/tracking").json()["incidents"][0]["road_id"] == "dunajska"


def test_position_interpolates_by_distance_and_keeps_corners():
    road = [(46.0, 14.0), (46.001, 14.0), (46.002, 14.0), (46.002, 14.001)]
    fallback = Point(lat=46, lon=14)
    halfway = position_on_path(road, .5, fallback)
    assert halfway[1] == 14.0
    assert 46.001 < halfway[0] < 46.002
    assert position_on_path(road, 2, fallback) == road[-1]


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
        assert client.get("/api/state").json()["vehicles"][0]["location"] != fix["location"]
