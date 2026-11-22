from dataclasses import dataclass
from typing import Literal, Protocol

from pydantic import BaseModel, Field, computed_field, model_validator

HORIZON = 10 * 3600
DEMO_DAY_START = -8 * 3600
DEMO_DAY_END = 16 * 3600 - 1
Priority = Literal["P1", "P2", "P3"]
# Longest wait between the desired pickup and the patient being in the vehicle; P1 has none and goes first.
MAX_WAIT: dict[Priority, int | None] = {"P1": None, "P2": 45 * 60, "P3": 120 * 60}
Strategy = Literal["MIN_DELAY", "MIN_CHANGES", "MAX_BUFFER"]
Equipment = Literal["WHEELCHAIR", "STRETCHER", "OXYGEN"]
TaskType = Literal["PLANNED_TRANSPORT", "PRIORITY_TRANSPORT", "EQUIPMENT_DELIVERY"]
IncidentType = Literal[
    "VEHICLE_BREAKDOWN", "VEHICLE_UNAVAILABLE", "TRAFFIC_DELAY", "ROAD_CLOSURE",
    "NEW_TASK", "WEATHER_DELAY", "FACILITY_CAPACITY_CHANGE", "FLEET_CHANGE",
]


class Point(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class Vehicle(BaseModel):
    id: str
    location: Point
    capacity: int
    equipment: list[Equipment]
    task_types: list[TaskType]
    available_at: int = 0
    broken: bool = False
    unavailable: list[tuple[int, int]] = Field(default_factory=list)
    repositioned_at: int | None = None
    # Removed from the fleet; kept so today's completed assignments still resolve their vehicle.
    retired: bool = False


class Facility(BaseModel):
    id: str
    name: str
    location: Point
    quota: int
    accepting: bool = True


class Task(BaseModel):
    id: str
    type: TaskType
    priority: Priority
    pickup: Point
    pickup_name: str | None = None
    facility_id: str
    passenger_count: int = Field(ge=0, le=8)
    equipment: list[Equipment] = Field(default_factory=list)
    # Stored tasks can predate the current shift bounds.
    earliest_pickup: int = Field(ge=0)
    latest_pickup: int | None = Field(default=None, ge=0)
    pickup_service: int = Field(default=240, ge=0, le=3600)
    dropoff_service: int = Field(default=240, ge=0, le=3600)
    cleaning: int = Field(default=120, ge=0, le=3600)
    planning_horizon: int | None = Field(default=None, ge=0)
    actual_pickup: int | None = None
    actual_arrival: int | None = None

    @property
    def asap(self) -> bool:
        return self.priority == "P1"

    @model_validator(mode="after")
    def priority_window(self):
        # The latest pickup always follows from priority, so stored or submitted values cannot drift from the rule.
        wait = MAX_WAIT[self.priority]
        if wait is None:
            self.latest_pickup = None
        else:
            latest = self.earliest_pickup + wait
            self.latest_pickup = min(self.planning_horizon or HORIZON, latest) if self.earliest_pickup <= (self.planning_horizon or HORIZON) else latest
        return self


class Reroute(BaseModel):
    at: int = Field(ge=DEMO_DAY_START)
    # A delayed leg may start after the planning horizon.
    start: int = Field(ge=0)
    origin: Point | None = None
    leg: Literal["PICKUP", "HOSPITAL"] | None = None


class Assignment(BaseModel):
    task_id: str
    vehicle_id: str
    planned_departure: int
    planned_pickup: int
    planned_dropoff: int
    planned_end: int
    deadhead: int
    status: Literal["PLANNED", "IN_PROGRESS", "COMPLETED"] = "PLANNED"
    is_locked: bool = False
    distance_meters: int | None = Field(default=None, ge=0)
    reroute: Reroute | None = None

    @computed_field
    @property
    def planned_arrival(self) -> int:
        return self.planned_dropoff


class Incident(BaseModel):
    id: int = 0
    type: IncidentType
    occurred_at: int = 0
    ended_at: int | None = Field(default=None, ge=DEMO_DAY_START)
    duration: int | None = Field(default=None, gt=0, le=HORIZON)
    vehicle_id: str | None = None
    facility_id: str | None = None
    task_id: str | None = None
    location: Point | None = None
    road_id: str | None = None
    radius_km: float = Field(default=1.5, gt=0, le=30)
    multiplier: float = Field(default=1.6, ge=1, le=5)
    quota: int | None = Field(default=None, ge=0, le=100)
    source: str = "SIMULATED"
    description: str = ""
    priority: Priority = "P2"
    status: Literal["OPEN", "RESOLVED"] = "OPEN"
    selected_recommendation_id: str | None = None
    resolved_at: str | None = None


class Issue(BaseModel):
    code: str
    task_id: str
    vehicle_id: str | None = None


class Metrics(BaseModel):
    assigned: int = 0
    unassigned: dict[Priority, int] = Field(default_factory=lambda: {"P1": 0, "P2": 0, "P3": 0})
    late_tasks: int = 0
    delay_seconds: int = 0
    travel_seconds: int = 0
    distance_meters: int | None = Field(default=None, ge=0)
    vehicle_changes: int = 0
    sequence_changes: int = 0
    time_changes: int = 0
    min_buffer_seconds: int = 0
    median_buffer_seconds: int = 0


class Change(BaseModel):
    task_id: str
    old_vehicle_id: str | None = None
    new_vehicle_id: str | None = None
    old_pickup: int | None = None
    new_pickup: int | None = None


class Candidate(BaseModel):
    strategy: Strategy
    assignments: list[Assignment]
    unassigned: list[Issue]
    blocking: list[Issue]
    metrics: Metrics
    changes: list[Change] = Field(default_factory=list)
    released_task_ids: list[str] = Field(default_factory=list)
    solver_status: str
    coverage_proven: bool
    solve_ms: int


@dataclass(frozen=True)
class Node:
    id: str
    kind: Literal["VEHICLE_START", "PICKUP", "DELIVERY"]
    point: Point


TravelMatrix = tuple[tuple[int | None, ...], ...]


@dataclass(frozen=True)
class TravelSnapshot:
    nodes: tuple[Node, ...]
    index: dict[str, int]
    durations: TravelMatrix
    source: str
    distances: TravelMatrix | None = None

    def __post_init__(self):
        size = len(self.nodes)
        if len(self.index) != size or self.index != {node.id: i for i, node in enumerate(self.nodes)}:
            raise ValueError("Invalid node indices")
        for matrix in (self.durations, self.distances):
            if matrix is None:
                continue
            if len(matrix) != size or any(len(row) != size for row in matrix):
                raise ValueError("Invalid travel matrix dimensions")
            if any(value is not None and (type(value) is not int or value < 0)
                   for row in matrix for value in row):
                raise ValueError("Invalid travel matrix value")
        if self.distances is not None and any(
            (duration is None) != (distance is None)
            for duration_row, distance_row in zip(self.durations, self.distances, strict=True)
            for duration, distance in zip(duration_row, distance_row, strict=True)
        ):
            raise ValueError("Road distance and duration reachability differ")

    def seconds(self, origin: str, destination: str) -> int | None:
        return self.durations[self.index[origin]][self.index[destination]]

    def meters(self, origin: str, destination: str) -> int | None:
        if self.distances is None:
            return None
        return self.distances[self.index[origin]][self.index[destination]]


@dataclass(frozen=True)
class Anchor:
    node: str
    time: int
    blocked: bool = False


@dataclass(frozen=True)
class PlanningSnapshot:
    now: int
    vehicles: dict[str, Vehicle]
    tasks: dict[str, Task]
    facilities: dict[str, Facility]
    previous: dict[str, Assignment]
    frozen: dict[str, Assignment]
    anchors: dict[str, Anchor]
    travel: TravelSnapshot
    blocking: tuple[Issue, ...]

    @property
    def horizon(self) -> int:
        return max([HORIZON, *(task.planning_horizon or HORIZON for task in self.tasks.values())])


@dataclass(frozen=True)
class SolveBudget:
    coverage_seconds: float = 3.0
    strategy_seconds: float = 2.0


@dataclass(frozen=True)
class PlanCandidate:
    plan: Candidate | None
    status: str


class Planner(Protocol):
    def solve(self, snapshot: PlanningSnapshot, strategy: Strategy, budget: SolveBudget) -> PlanCandidate: ...
