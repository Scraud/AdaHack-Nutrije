from dataclasses import dataclass
from datetime import datetime
from xml.etree.ElementTree import Element

from app.planning.contracts import Point
from app.providers.http import read_xml


@dataclass(frozen=True)
class TrafficEvent:
    id: str
    start: datetime
    end: datetime | None
    point: Point | None
    description: str
    closure: bool


def date(value: str | None) -> datetime:
    if not value:
        raise ValueError("Missing DATEX II timestamp")
    result = datetime.fromisoformat(value)
    if result.tzinfo is None:
        raise ValueError("Missing DATEX II timezone")
    return result


def coordinates(record: Element) -> Point | None:
    point = record.find(".//{*}coordinatesForDisplay")
    if point is None:
        return None
    try:
        return Point(lat=float(point.findtext("{*}latitude", "")),
                     lon=float(point.findtext("{*}longitude", "")))
    except ValueError:
        return None


def traffic_publication(content: bytes, now: datetime) -> tuple[datetime, list[TrafficEvent]]:
    root = read_xml(content)
    publication = root if root.find("{*}publicationTime") is not None else root.find(".//{*}payload")
    if publication is None:
        raise ValueError("Missing DATEX II publication")
    published = date(publication.findtext("{*}publicationTime"))
    by_id = {}
    for record in publication.findall(".//{*}situationRecord"):
        event_id = record.get("id")
        if not event_id:
            continue
        start = date(record.findtext(".//{*}overallStartTime") or record.findtext("{*}situationRecordCreationTime"))
        end_text = record.findtext(".//{*}overallEndTime")
        end = date(end_text) if end_text else None
        inactive = record.findtext(".//{*}validityStatus") == "suspended"
        version = int(record.get("version", "0"))
        if start > now or (end and now >= end) or inactive or (event_id in by_id and version <= by_id[event_id][0]):
            continue
        comment = record.find(".//{*}generalPublicComment")
        description = comment.findtext(".//{*}value") if comment is not None else None
        closure = record.findtext(".//{*}trafficConstrictionType") == "roadClosed"
        by_id[event_id] = version, TrafficEvent(event_id, start, end, coordinates(record),
                                                description or "Prometni dogodek", closure)
    return published, [event for _, event in by_id.values()]
