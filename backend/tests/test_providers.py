from datetime import UTC, datetime

import pytest

from app.planning.contracts import Node, Point
from app.providers.arso import latest_observation
from app.providers.nap import traffic_publication
from app.providers.osrm import parse_table


def test_osrm_keeps_logical_indices_direction_and_unreachable_paths():
    point = Point(lat=46.05, lon=14.5)
    nodes = (Node("V1", "VEHICLE_START", point), Node("T01", "PICKUP", point))
    result = parse_table(nodes, b'{"code":"Ok","durations":[[0,1.01],[null,0]]}')
    assert result.index == {"V1": 0, "T01": 1}
    assert result.seconds("V1", "T01") == 2
    assert result.seconds("T01", "V1") is None
    assert result.source == "OSRM"
    with pytest.raises(ValueError):
        parse_table(nodes, b'{"code":"Ok","durations":[[0,1.01]]}')


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
