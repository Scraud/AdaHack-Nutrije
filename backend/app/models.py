from typing import Any

from sqlalchemy import ForeignKey, Index, JSON, UniqueConstraint, text
from sqlalchemy.orm import DeclarativeBase, Mapped, declared_attr, mapped_column


class Base(DeclarativeBase):
    pass


class Scenario(Base):
    __tablename__ = "scenario_state"
    id: Mapped[str] = mapped_column(primary_key=True)
    current: Mapped[bool] = mapped_column(default=True)
    revision: Mapped[int] = mapped_column(default=0)
    now: Mapped[int] = mapped_column(default=0)
    start_at: Mapped[str]
    __table_args__ = (Index("only_current_scenario", "current", unique=True, sqlite_where=text("current = 1")),)


class Scoped:
    @declared_attr
    def scenario_id(cls) -> Mapped[str]:
        return mapped_column(ForeignKey("scenario_state.id"), index=True)


class Entity:
    id: Mapped[str] = mapped_column(primary_key=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)

    @declared_attr
    def scenario_id(cls) -> Mapped[str]:
        return mapped_column(ForeignKey("scenario_state.id"), primary_key=True)


class VehicleRecord(Entity, Base):
    __tablename__ = "vehicles"


class FacilityRecord(Entity, Base):
    __tablename__ = "facilities"


class TaskRecord(Entity, Base):
    __tablename__ = "tasks"


class ScheduledTaskRecord(Entity, Base):
    __tablename__ = "scheduled_tasks"


class IncidentRecord(Scoped, Base):
    __tablename__ = "incidents"
    id: Mapped[int] = mapped_column(primary_key=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)


class SnapshotRecord(Base):
    __tablename__ = "input_snapshots"
    id: Mapped[str] = mapped_column(primary_key=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)


class Plan(Scoped, Base):
    __tablename__ = "plans"
    id: Mapped[str] = mapped_column(primary_key=True)
    version: Mapped[int | None]
    status: Mapped[str]
    snapshot_id: Mapped[str] = mapped_column(ForeignKey("input_snapshots.id"))
    created_at: Mapped[str]
    result: Mapped[dict[str, Any]] = mapped_column(JSON)
    __table_args__ = (
        UniqueConstraint("scenario_id", "version"),
        Index("one_active_plan", "scenario_id", unique=True, sqlite_where=text("status = 'ACTIVE'")),
    )


class AssignmentRecord(Base):
    __tablename__ = "assignments"
    plan_id: Mapped[str] = mapped_column(ForeignKey("plans.id"), primary_key=True)
    task_id: Mapped[str] = mapped_column(primary_key=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)


class Recommendation(Scoped, Base):
    __tablename__ = "recommendations"
    id: Mapped[str] = mapped_column(primary_key=True)
    base_plan_id: Mapped[str] = mapped_column(ForeignKey("plans.id"))
    proposed_plan_id: Mapped[str] = mapped_column(ForeignKey("plans.id"), unique=True)
    base_revision: Mapped[int]
    status: Mapped[str]


class Decision(Base):
    __tablename__ = "decisions"
    id: Mapped[int] = mapped_column(primary_key=True)
    recommendation_id: Mapped[str] = mapped_column(ForeignKey("recommendations.id"), unique=True)
    action: Mapped[str]
    reason: Mapped[str]
    actor: Mapped[str]
    created_at: Mapped[str]


class Audit(Scoped, Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(primary_key=True)
    action: Mapped[str]
    actor: Mapped[str]
    created_at: Mapped[str]
    details: Mapped[dict[str, Any]] = mapped_column(JSON)
