from datetime import UTC, datetime

import httpx
import pytest

from app.planning.contracts import Node, Point
from app.providers.arso import latest_observation
from app.providers.nap import traffic_publication
from app.providers.osrm import parse_table, road_snapshot


def test_osrm_keeps_logical_indices_direction_and_unreachable_paths():
    start = Point(lat=46.05, lon=14.5)
    pickup = Point(lat=46.06, lon=14.51)
    nodes = (Node("V1", "VEHICLE_START", start), Node("T01", "PICKUP", pickup), Node("T02", "PICKUP", pickup))

    def table(request):
        assert request.url.path.endswith("/14.500000,46.050000;14.510000,46.060000")
        assert request.url.params["annotations"] == "duration,distance"
        return httpx.Response(200, json={
            "code": "Ok", "durations": [[0, 1.01], [None, 0]], "distances": [[0, 8.2], [None, 0]],
        })

    with httpx.Client(transport=httpx.MockTransport(table)) as client:
        result = road_snapshot(client, "http://osrm:5000", nodes)
    assert result.index == {"V1": 0, "T01": 1, "T02": 2}
    assert result.seconds("V1", "T01") == 2
    assert result.meters("V1", "T01") == result.meters("V1", "T02") == 9
    assert result.seconds("T01", "V1") is None
    assert result.meters("T01", "V1") is None
    assert result.source == "OSRM"


@pytest.mark.parametrize("body", [
    b'{"code":"Ok","durations":[[0,1.01]]}',
    b'{"code":"Ok","durations":[[0,1],[1,0]],"distances":[[0,50],[null,0]]}',
])
def test_osrm_requires_complete_consistent_matrices(body):
    with pytest.raises(ValueError):
        parse_table(body, 2, 2)


def test_arso_timestamp_and_xml_validation():
    sample = b"""<data><metData><tsValid_issued_RFC822>21 Nov 2026 14:20:00 +0100</tsValid_issued_RFC822>
      <t>4.3</t></metData></data>"""
    result = latest_observation(sample)
    assert result.time == datetime(2026, 11, 21, 13, 20, tzinfo=UTC)
    assert "4.3" in result.description
    with pytest.raises(ValueError):
        latest_observation(b"<!DOCTYPE data><data />")


def test_nap_deduplicates_and_validates_locations():
    xml = b"""<SituationPublication xmlns="http://datex2.eu/schema/3/situation">
      <publicationTime>2026-11-21T12:50:00Z</publicationTime><situation>
      <situationRecord id="a" version="1"><overallStartTime>2026-11-21T12:00:00Z</overallStartTime></situationRecord>
      <situationRecord id="a" version="2"><overallStartTime>2026-11-21T12:00:00Z</overallStartTime>
        <coordinatesForDisplay><latitude>980</latitude><longitude>14.05</longitude></coordinatesForDisplay>
        <trafficConstrictionType>roadClosed</trafficConstrictionType></situationRecord>
      <situationRecord id="b"><overallStartTime>2026-11-21T11:00:00Z</overallStartTime>
        <overallEndTime>2026-11-21T11:30:00Z</overallEndTime></situationRecord></situation>
      </SituationPublication>"""
    _, events = traffic_publication(xml, datetime(2026, 11, 21, 13, tzinfo=UTC))
    assert [(item.id, item.closure, item.point) for item in events] == [("a", True, None)]
