from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from functools import partial
from secrets import compare_digest
from threading import Lock
from time import monotonic
from typing import Literal

from pydantic import BaseModel, Field

from app.db import Database
from app.models import SnapshotRecord, VehicleRecord
from app.planning.contracts import HORIZON, Incident, Point
from app.planning.snapshot_builder import routes
from app.planning.validator import validate_plan
from app.providers.osrm import RoadMatrix
from app.providers.roads import Coordinate, active_conditions, center_distance, road_network
from app.services.simulation import advance
from app.services.state import active_plan, inputs, problem, scenario


class GPSFix(BaseModel):
    vehicle_id: str
    location: Point
    recorded_at: datetime


class Playback(BaseModel):
    playing: bool
    speed: Literal[30, 60, 300] = 60


class DestinationETA(BaseModel):
    destination: Literal["PICKUP", "HOSPITAL"]
    seconds: int = Field(ge=0)


class TrackedVehicle(BaseModel):
    id: str
    location: Coordinate
    status: Literal["WAITING", "TO_PICKUP", "AT_PICKUP", "TO_HOSPITAL", "AT_HOSPITAL", "STOPPED", "GPS"]
    task_id: str | None = None
    to_pickup: list[Coordinate] = Field(default_factory=list)
    to_hospital: list[Coordinate] = Field(default_factory=list)
    eta: DestinationETA | None = None
    recorded_at: datetime | None = None
    stale: bool = False


class RoadEvent(BaseModel):
    id: int
    road_id: str
    type: Literal["TRAFFIC_DELAY", "ROAD_CLOSURE"]


class TrackingFrame(BaseModel):
    scenario_id: str
    revision: int
    now: int
    mode: Literal["DEMO", "GPS"]
    playback: Playback
    vehicles: list[TrackedVehicle]
    incidents: list[RoadEvent]


def position_on_path(path: list[Coordinate], progress: float, fallback: Point) -> Coordinate:
    if not path:
        return fallback.lat, fallback.lon
    if len(path) == 1 or progress <= 0:
        return path[0]
    if progress >= 1:
        return path[-1]
    lengths = [center_distance(a, b) for a, b in zip(path, path[1:])]
    remaining = sum(lengths) * progress
    for a, b, length in zip(path, path[1:], lengths):
        if length and remaining <= length:
            ratio = remaining / length
            return a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio
        remaining -= length
    return path[-1]


class Tracking:
    def __init__(self, database: Database, gps_key: str | None, road_matrix: RoadMatrix | None = None):
        self.database = database
        self.gps_key = gps_key
        self.road_matrix = road_matrix
        self.lock = Lock()
        self.playback = Playback(playing=False)
        self.last_tick = monotonic()
        self.fixes: dict[str, GPSFix] = {}

    def pause(self):
        with self.lock:
            self.playback = self.playback.model_copy(update={"playing": False})

    def control(self, playback: Playback):
        if self.gps_key:
            raise problem(409, "GPS_ENABLED", "Spremljanje GPS je vključeno.")
        with self.lock, self.database.session() as db:
            if playback.playing and (not active_plan(db, scenario(db)) or scenario(db).now >= HORIZON):
                raise problem(409, "PLAYBACK_UNAVAILABLE", "Za predvajanje ustvarite plan znotraj simuliranega dne.")
            self.playback = playback
            self.last_tick = monotonic()
            return self.playback

    def tick(self):
        with self.lock:
            if not self.playback.playing:
                return
            now = monotonic()
            increment = int((now - self.last_tick) * self.playback.speed)
            if not increment:
                return
            self.last_tick += increment / self.playback.speed
            with self.database.session(write=True) as db:
                scope = scenario(db)
                until = min(HORIZON, scope.now + increment)
                if scope.now < until:
                    advance(db, scope, until, self.road_matrix, record_audit=False)
                if until >= HORIZON:
                    self.playback = self.playback.model_copy(update={"playing": False})

    def record_gps(self, fix: GPSFix, authorization: str | None):
        if not self.gps_key:
            raise problem(404, "GPS_DISABLED", "Sprejem GPS ni nastavljen.")
        if not authorization or not compare_digest(authorization.encode(), f"Bearer {self.gps_key}".encode()):
            raise problem(401, "GPS_UNAUTHORIZED", "Potreben je veljaven ključ GPS.")
        now = datetime.now(UTC)
        if fix.recorded_at.tzinfo is None or fix.recorded_at > now + timedelta(seconds=30):
            raise problem(400, "GPS_TIMESTAMP_INVALID", "Čas GPS mora vključevati časovni pas.")
        with self.lock, self.database.session() as db:
            scope = scenario(db)
            if db.get(VehicleRecord, (fix.vehicle_id, scope.id)) is None:
                raise problem(404, "VEHICLE_NOT_FOUND", "Vozilo ne obstaja.")
            previous = self.fixes.get(fix.vehicle_id)
            if not previous or fix.recorded_at > previous.recorded_at:
                self.fixes[fix.vehicle_id] = fix

    def frame(self) -> TrackingFrame:
        with self.lock:
            playback = self.playback
            fixes = tuple(self.fixes.values())
        with self.database.session() as db:
            scope = scenario(db)
            plan = active_plan(db, scope)
            state, incidents, rows = inputs(db, scope, plan, self.road_matrix, preserve_active_timing=True)
            if self.gps_key:
                now = datetime.now(UTC)
                vehicles = [TrackedVehicle(
                    id=fix.vehicle_id, location=(fix.location.lat, fix.location.lon), status="GPS",
                    recorded_at=fix.recorded_at, stale=now - fix.recorded_at > timedelta(seconds=15),
                ) for fix in fixes]
            else:
                saved = db.get(SnapshotRecord, plan.snapshot_id).payload if plan else {}
                planned_incidents = [Incident.model_validate(event) for event in saved.get("incidents", [])]
                planned_at = saved.get("now", 0)
                roads = road_network()
                path = partial(roads.road_path, effects=roads.effects(active_conditions(planned_at, planned_incidents)))
                if saved.get("provider") == "OSRM" and self.road_matrix is not None:
                    path = self.road_matrix.path
                vehicles = demo_positions(state, incidents, rows, path, planned_at)
            overlays = [RoadEvent(id=event.id, road_id=event.road_id, type=event.type)
                        for event in active_conditions(scope.now, incidents)
                        if event.road_id and event.type in ("TRAFFIC_DELAY", "ROAD_CLOSURE")]
            return TrackingFrame(scenario_id=scope.id, now=scope.now, revision=scope.revision,
                                 mode="GPS" if self.gps_key else "DEMO", playback=playback,
                                 vehicles=vehicles, incidents=overlays)


def demo_positions(state, incidents, rows, road_path: Callable[[Point, Point], list[Coordinate]], planned_at: int):
    by_vehicle = routes(rows)
    blocked = {issue.task_id for issue in state.blocking}
    invalid = {issue.task_id for issue in validate_plan(state, rows)}
    result = []
    for vehicle in state.vehicles.values():
        origin = vehicle.location
        upcoming = None
        for row in by_vehicle.get(vehicle.id, []):
            if row.status == "COMPLETED":
                origin = state.facilities[state.tasks[row.task_id].facility_id].location
            elif row.status == "IN_PROGRESS" or (not vehicle.broken and row.planned_departure >= state.now):
                upcoming = row
                break
        location = position_on_path(road_path(origin, origin), 0, origin)
        if upcoming is None:
            result.append(TrackedVehicle(id=vehicle.id, location=location,
                                         status="STOPPED" if vehicle.broken else "WAITING"))
            continue
        task = state.tasks[upcoming.task_id]
        destination = state.facilities[task.facility_id].location
        approach = road_path(origin, task.pickup)
        delivery = road_path(task.pickup, destination)
        at = state.now
        stopped = vehicle.broken or task.id in blocked
        if stopped:
            causes = [event.occurred_at for event in incidents if
                      (event.type in ("VEHICLE_BREAKDOWN", "VEHICLE_UNAVAILABLE") and event.vehicle_id == vehicle.id)
                      or event.type in ("TRAFFIC_DELAY", "ROAD_CLOSURE", "WEATHER_DELAY", "FACILITY_CAPACITY_CHANGE")
                      and event.occurred_at >= planned_at]
            at = min(at, max(upcoming.planned_departure, min(causes, default=at)))
        pickup_end = upcoming.planned_pickup + task.pickup_service
        if at < upcoming.planned_departure:
            status = "WAITING"
        elif at < upcoming.planned_pickup:
            status = "TO_PICKUP"
            location = position_on_path(approach, (at - upcoming.planned_departure) /
                                        (upcoming.planned_pickup - upcoming.planned_departure), origin)
        elif at < pickup_end:
            status = "AT_PICKUP"
            location = position_on_path(delivery, 0, task.pickup)
        elif at < upcoming.planned_dropoff:
            status = "TO_HOSPITAL"
            location = position_on_path(delivery, (at - pickup_end) /
                                        (upcoming.planned_dropoff - pickup_end), task.pickup)
        else:
            status = "AT_HOSPITAL"
            location = position_on_path(delivery, 1, destination)
        eta = None
        if not stopped and task.id not in invalid:
            if status in ("WAITING", "TO_PICKUP") and approach:
                eta = DestinationETA(destination="PICKUP", seconds=upcoming.planned_pickup - state.now)
            elif status in ("AT_PICKUP", "TO_HOSPITAL") and delivery:
                eta = DestinationETA(destination="HOSPITAL", seconds=upcoming.planned_dropoff - state.now)
        result.append(TrackedVehicle(id=vehicle.id, location=location, status="STOPPED" if stopped else status,
                                     task_id=task.id, to_pickup=approach, to_hospital=delivery, eta=eta))
    return result
