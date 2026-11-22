from datetime import datetime
from typing import Literal

from pydantic import AwareDatetime, BaseModel, Field

from app.planning.contracts import (
    Assignment, DEMO_DAY_END, DEMO_DAY_START, Equipment, Facility, HORIZON, Incident, IncidentType, Issue, Metrics,
    Point, Priority, Strategy, Task, TaskType, Vehicle, Candidate,
)


class NewTask(BaseModel):
    priority: Priority
    pickup: Point
    pickup_name: str | None = Field(default=None, min_length=1, max_length=200)
    passenger_count: int = Field(default=1, ge=1, le=8)
    equipment: list[Equipment] = Field(default_factory=list)
    earliest_pickup: int | None = Field(default=None, ge=0, le=HORIZON)


class CreateIncident(BaseModel):
    type: IncidentType
    description: str = Field(default="", max_length=1000)
    priority: Priority = "P2"
    duration: int | None = Field(default=None, gt=0, le=HORIZON)
    vehicle_id: str | None = None
    facility_id: str | None = None
    location: Point | None = None
    road_id: str | None = None
    radius_km: float | None = Field(default=None, gt=0, le=30)
    multiplier: float | None = Field(default=None, ge=1, le=5)
    quota: int | None = Field(default=None, ge=0, le=100)
    task: NewTask | None = None


class Advance(BaseModel):
    to: int = Field(gt=0, le=HORIZON)


class CreateScheduledTask(BaseModel):
    scheduled_at: AwareDatetime
    pickup: Point
    pickup_name: str = Field(min_length=1, max_length=200)
    facility_id: str
    priority: Priority = "P3"
    passenger_count: int = Field(default=1, ge=1, le=8)
    equipment: list[Equipment] = Field(default_factory=list)
    description: str = Field(default="", max_length=1000)


class ScheduledTaskView(BaseModel):
    id: str
    scheduled_at: AwareDatetime
    task: Task
    description: str = ""


class DemoClock(BaseModel):
    # The seeded operating shift begins at 08:00; the demo clock covers the calendar day.
    to: int = Field(ge=DEMO_DAY_START, le=DEMO_DAY_END)


class Replan(BaseModel):
    base_plan_id: str
    expected_state_revision: int = Field(ge=0)


class AssignmentMove(BaseModel):
    task_id: str
    vehicle_id: str
    planned_pickup: int = Field(ge=0, le=HORIZON)


class ManualMove(Replan, AssignmentMove):
    pass


class ManualSolution(Replan):
    moves: list[AssignmentMove] = Field(min_length=1, max_length=200)


class Rejection(BaseModel):
    reason: str = Field(default="", max_length=500)


class PlanSummary(BaseModel):
    id: str
    version: int | None
    status: str
    created_at: str
    strategy: str
    metrics: Metrics


class PlanView(Candidate):
    id: str
    version: int | None
    status: str
    created_at: str
    snapshot_id: str
    assignments: list[Assignment]


class RecommendationView(BaseModel):
    id: str
    base_plan_id: str
    base_revision: int
    status: str
    plan: PlanView
    decision_reason: str | None = None
    decided_at: str | None = None
    incident_ids: list[int] = Field(default_factory=list)


class Recommendations(BaseModel):
    items: list[RecommendationView]
    solver_statuses: list[str]
    duration_ms: int


class Flag(BaseModel):
    code: Literal["UNASSIGNED", "RESOLVED", "CREW_NOTICE", "TIGHT_DEADLINE", "LATER_PICKUP", "CASCADE",
                  "FACILITY_BUNCHING", "SHARED_DELAY_EXPOSURE"]
    severity: Literal["HIGH", "MEDIUM", "INFO"]
    message: str
    short: str
    task_ids: list[str] = Field(default_factory=list)
    vehicle_ids: list[str] = Field(default_factory=list)


class TaskImpact(BaseModel):
    task_id: str
    priority: Priority
    old_vehicle_id: str | None = None
    new_vehicle_id: str | None = None
    old_pickup: int | None = None
    new_pickup: int | None = None
    delay_seconds: int | None = None
    margin_seconds: int | None = None


class Explanation(BaseModel):
    recommendation_id: str
    strategy: Strategy
    source: Literal["OLLAMA", "RULES"]
    model: str | None = None
    pros: list[str]
    cons: list[str]
    flags: list[Flag]
    impacts: list[TaskImpact]
    notice: str | None = None


class Baseline(BaseModel):
    metrics: Metrics
    affected: list[Issue]
    simulated_pickups: int
    simulated_arrivals: int


class VehicleSettings(BaseModel):
    capacity: int = Field(ge=1, le=8)
    equipment: list[Equipment] = Field(default_factory=list)
    task_types: list[TaskType] = Field(min_length=1)


class NewVehicle(VehicleSettings):
    location: Point


class VehicleView(Vehicle):
    status: Literal["AVAILABLE", "UNAVAILABLE", "EN_ROUTE", "TRANSPORTING", "SERVICE", "BROKEN"]
    next_available: int | None


class State(BaseModel):
    scenario_id: str
    revision: int
    mode: Literal["DEMO"] = "DEMO"
    start_at: str
    now: int
    horizon: int = HORIZON
    travel_source: str = "OSM_LJUBLJANA"
    vehicles: list[VehicleView]
    facilities: list[Facility]
    tasks: list[Task]
    scheduled_tasks: list[ScheduledTaskView] = Field(default_factory=list)
    incidents: list[Incident]
    active_plan: PlanView | None
    baseline: Baseline


class SourceStatus(BaseModel):
    id: str
    name: str
    status: Literal["SIMULATED", "LIVE", "STALE", "UNAVAILABLE"]
    message: str
    observed_at: datetime | None = None


class RoadLayer(BaseModel):
    rank: int
    paths: list[list[tuple[float, float]]]


class RoadSegment(BaseModel):
    id: str
    name: str
    paths: list[list[tuple[float, float]]]


class RoadMap(BaseModel):
    bounds: tuple[float, float, float, float]
    timestamp: str
    layers: list[RoadLayer]
    streets: list[str]


class PickupAddress(Point):
    name: str
