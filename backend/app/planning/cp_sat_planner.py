from dataclasses import dataclass
from time import monotonic

from ortools.sat.python import cp_model as cp

from app.planning.contracts import (
    Assignment, Candidate, PlanCandidate, PlanningSnapshot, SolveBudget, Strategy,
)
from app.planning.snapshot_builder import compatible, delivery, facility_remaining, pickup, transport_distance
from app.planning.validator import validate_plan
from app.services.metrics import explain, metrics, predecessors

STRATEGIES: tuple[Strategy, ...] = ("MIN_DELAY", "MIN_CHANGES", "MAX_BUFFER")
Arc = tuple[str, str | None, str | None]
PRIORITY_WEIGHT = {"P1": 8, "P2": 3, "P3": 1}
# Cost of a second past the latest pickup; low priority is shifted first when not every window fits.
OVERRUN_WEIGHT = {"P2": 10, "P3": 1}
BUFFER_TARGET = 20 * 60
NEAR_TERM = 3600
SCALE = 100


@dataclass(frozen=True)
class Profile:
    """Costs in minutes of P3 delay, so every strategy trades the same criteria at different rates."""
    change: float
    near_change: float
    sequence: float
    shift: float
    shortfall: float
    travel: float
    delay: float = 1.0


PROFILES: dict[Strategy, Profile] = {
    "MIN_DELAY": Profile(change=3, near_change=3, sequence=0.5, shift=0.05, shortfall=0.1, travel=0.05),
    "MIN_CHANGES": Profile(change=30, near_change=15, sequence=6, shift=0.25, shortfall=0.1, travel=0.02),
    "MAX_BUFFER": Profile(change=6, near_change=6, sequence=1, shift=0.05, shortfall=1.5, travel=0.02, delay=0.5),
}


@dataclass
class Terms:
    travel: cp.LinearExprT
    delays: list[tuple[int, cp.IntVar]]
    switched: list[cp.LinearExprT]
    near_switched: list[cp.LinearExprT]
    predecessor_changes: list[cp.LinearExprT]
    shifts: list[cp.IntVar]
    shortfalls: list[cp.IntVar]


@dataclass
class Times:
    departure: cp.IntVar
    pickup: cp.IntVar
    latest: cp.IntVar
    loaded: int
    to_dropoff: int
    to_end: int
    lower: int
    upper: int


class ScheduleModel:
    def __init__(self, state: PlanningSnapshot, soft_windows: bool = False):
        self.state = state
        self.soft_windows = soft_windows
        self.window_dropped = 0
        self.model = cp.CpModel()
        self.times: dict[str, Times] = {}
        self.choices: dict[tuple[str, str], cp.IntVar] = {}
        self.arcs: dict[Arc, tuple[cp.IntVar, int]] = {}
        self.present: dict[str, cp.IntVar] = {}
        self.min_buffer = self.model.new_int_var(0, self.state.horizon, "min_buffer")
        self._terms: Terms | None = None
        self.overruns: list[tuple[str, cp.IntVar]] = []
        self._add_tasks()
        self._add_routes()
        base = len(state.tasks) + 1
        weights = {"P1": base * base, "P2": base, "P3": 1}
        self.coverage = sum(weights[state.tasks[key].priority] * present
                            for key, present in self.present.items() if key not in state.frozen)
        urgent = []
        urgent_count = []
        for key, times in self.times.items():
            task = state.tasks[key]
            if key in state.frozen or not task.asap:
                continue
            present = self.present[key]
            # P1 waiting time from the desired pickup; unscheduled pickups sit at their lower bound and count as zero.
            urgent.append(times.pickup - times.lower + present * (times.lower - task.earliest_pickup))
            urgent_count.append(present)
        urgent_weight = self.state.horizon * len(urgent) + 1
        self.urgent = sum(urgent) - urgent_weight * sum(urgent_count) if urgent else None
        self.overrun = sum(OVERRUN_WEIGHT[priority] * over for priority, over in self.overruns) if self.overruns else None

    def _add_tasks(self):
        blocked = {issue.task_id for issue in self.state.blocking}
        for key, task in self.state.tasks.items():
            fixed = self.state.frozen.get(key)
            if fixed and (fixed.status != "PLANNED" or key in blocked):
                continue
            loaded = self.state.travel.seconds(pickup(key), delivery(key))
            if loaded is None:
                continue
            to_dropoff = task.pickup_service + loaded
            to_end = to_dropoff + task.dropoff_service + task.cleaning
            # With soft windows only the planning horizon is a hard limit and the latest pickup is priced as overrun.
            upper = self.state.horizon - to_end
            if task.latest_pickup is not None and not self.soft_windows:
                upper = min(upper, task.latest_pickup)
            lower = max(task.earliest_pickup, self.state.now)
            if upper < lower and fixed is None:
                self.window_dropped += lower <= self.state.horizon - to_end
                continue
            model = self.model
            if fixed:
                lower = upper = fixed.planned_pickup
            times = Times(
                model.new_int_var(self.state.now, self.state.horizon, f"departure_{key}"),
                model.new_int_var(lower, upper, f"pickup_{key}"),
                model.new_int_var(lower, upper, f"latest_{key}"),
                loaded, to_dropoff, to_end, lower, upper,
            )
            present = model.new_bool_var(f"scheduled_{key}")
            self.times[key], self.present[key] = times, present
            model.add(times.latest >= times.pickup)
            if fixed:
                model.add(present == 1)
                model.add(times.departure == fixed.planned_departure)
            else:
                if task.latest_pickup is not None and self.soft_windows:
                    over = model.new_int_var(0, self.state.horizon, f"over_{key}")
                    model.add(over >= times.pickup - task.latest_pickup).only_enforce_if(present)
                    model.add(over == 0).only_enforce_if(~present)
                    # Buffer is measured against the window, or against the pickup once the window is exceeded.
                    model.add(times.latest <= task.latest_pickup + over).only_enforce_if(present)
                    self.overruns.append((task.priority, over))
                model.add(self.min_buffer <= times.latest - times.pickup).only_enforce_if(present)
                model.add(times.pickup == lower).only_enforce_if(~present)
        for facility in self.state.facilities.values():
            arrivals = [present for key, present in self.present.items()
                        if self.state.tasks[key].facility_id == facility.id and key not in self.state.frozen
                        and self.state.tasks[key].uses_patient_quota]
            self.model.add(sum(arrivals) <= (facility_remaining(self.state, facility.id) if facility.accepting else 0))

    def _add_routes(self):
        for vehicle_id, anchor in self.state.anchors.items():
            vehicle = self.state.vehicles[vehicle_id]
            keys = []
            for key, times in self.times.items():
                fixed = self.state.frozen.get(key)
                if fixed:
                    if fixed.vehicle_id != vehicle_id:
                        continue
                elif anchor.blocked or not compatible(vehicle, self.state.tasks[key]):
                    continue
                choice = self.model.new_bool_var(f"{vehicle_id}_{key}")
                self.choices[vehicle_id, key] = choice
                keys.append(key)
                for begin, end in vehicle.unavailable:
                    before = self.model.new_bool_var(f"{vehicle_id}_{key}_before_{begin}")
                    self.model.add(times.latest + times.to_end <= begin).only_enforce_if(choice, before)
                    self.model.add(times.departure >= end).only_enforce_if(choice, ~before)
            if not keys:
                continue
            empty = self.model.new_bool_var(f"empty_{vehicle_id}")
            choices = [self.choices[vehicle_id, key] for key in keys]
            self.model.add(sum(choices) == 0).only_enforce_if(empty)
            self.model.add(sum(choices) >= 1).only_enforce_if(~empty)
            circuit = [(0, 0, empty)]
            nodes = [None, *keys]
            for i, origin in enumerate(nodes):
                if origin is not None:
                    circuit.append((i, i, ~self.choices[vehicle_id, origin]))
                for j, target in enumerate(nodes):
                    if i == j:
                        continue
                    edge = self._edge(vehicle_id, origin, target)
                    if edge is not None:
                        circuit.append((i, j, edge))
            self.model.add_circuit(circuit)
        for key, present in self.present.items():
            self.model.add(sum(choice for (_, task_id), choice in self.choices.items() if task_id == key) == present)

    def _edge(self, vehicle: str, origin: str | None, target: str | None) -> cp.IntVar | None:
        model = self.model
        if target is None:
            edge = model.new_bool_var(f"end_{vehicle}_{origin}")
            self.arcs[vehicle, origin, target] = edge, 0
            return edge
        anchor = self.state.anchors[vehicle]
        source = delivery(origin) if origin is not None else anchor.node
        deadhead = self.state.travel.seconds(source, pickup(target))
        upcoming = self.times[target]
        prior = self.times[origin] if origin is not None else None
        earliest = prior.lower + prior.to_end if prior else anchor.time
        if deadhead is None or earliest + deadhead > upcoming.upper:
            return None
        edge = model.new_bool_var(f"arc_{vehicle}_{origin}_{target}")
        self.arcs[vehicle, origin, target] = edge, deadhead
        model.add(upcoming.departure >= (prior.pickup + prior.to_end if prior else anchor.time)).only_enforce_if(edge)
        fixed = self.state.frozen.get(target)
        if fixed:
            model.add(upcoming.departure + deadhead <= upcoming.pickup).only_enforce_if(edge)
        else:
            model.add(upcoming.departure + deadhead == upcoming.pickup).only_enforce_if(edge)
        if prior:
            deadline = fixed.planned_departure if fixed else upcoming.latest - deadhead
            model.add(prior.latest + prior.to_end <= deadline).only_enforce_if(edge)
        return edge

    def set_objective(self, strategy: Strategy):
        profile, terms = PROFILES[strategy], self._objective_terms()

        def weight(factor: float) -> int:
            return round(SCALE * factor)

        cost = weight(profile.travel) * terms.travel
        cost += sum(weight(profile.delay * PRIORITY_WEIGHT[priority]) * delay for priority, delay in terms.delays)
        cost += weight(60 * profile.change) * sum(terms.switched)
        cost += weight(60 * profile.near_change) * sum(terms.near_switched)
        cost += weight(60 * profile.sequence) * sum(terms.predecessor_changes)
        cost += weight(profile.shift) * sum(terms.shifts)
        cost += weight(profile.shortfall) * sum(terms.shortfalls)
        if strategy == "MAX_BUFFER":
            cost -= weight(profile.shortfall) * self.min_buffer
        self.model.minimize(cost)

    def _objective_terms(self) -> Terms:
        if self._terms is not None:
            return self._terms
        travel = sum(edge * seconds for edge, seconds in self.arcs.values())
        travel += sum(self.present[key] * times.loaded for key, times in self.times.items())
        delays = []
        shifts = []
        switched = []
        near_switched = []
        predecessor_changes = []
        shortfalls = []
        previous = predecessors(list(self.state.previous.values()))
        for key, times in self.times.items():
            if key in self.state.frozen:
                continue
            task = self.state.tasks[key]
            present = self.present[key]
            shortfall = self.model.new_int_var(0, BUFFER_TARGET, f"shortfall_{key}")
            self.model.add(shortfall >= BUFFER_TARGET - (times.latest - times.pickup)).only_enforce_if(present)
            shortfalls.append(shortfall)
            if not task.asap:
                delay = self.model.new_int_var(0, self.state.horizon, f"delay_{key}")
                self.model.add(delay >= times.pickup - task.earliest_pickup).only_enforce_if(present)
                self.model.add(delay == 0).only_enforce_if(~present)
                delays.append((task.priority, delay))
            old = self.state.previous.get(key)
            if old is None:
                continue
            same_vehicle = self.choices.get((old.vehicle_id, key), 0)
            switched.append(1 - same_vehicle)
            if old.planned_departure - self.state.now < NEAR_TERM:
                near_switched.append(1 - same_vehicle)
            same_predecessor = self.arcs.get((old.vehicle_id, previous[key], key))
            barrier = self.state.frozen.get(previous[key]) if previous[key] is not None else None
            if (same_predecessor is None and barrier and barrier.status != "PLANNED"
                and self.state.anchors[old.vehicle_id].node == delivery(barrier.task_id)):
                same_predecessor = self.arcs.get((old.vehicle_id, None, key))
            if same_predecessor is not None:
                predecessor_changes.append(1 - same_predecessor[0])
            shift = self.model.new_int_var(0, self.state.horizon, f"shift_{key}")
            self.model.add(shift >= times.pickup - old.planned_pickup).only_enforce_if(present)
            self.model.add(shift >= old.planned_pickup - times.pickup).only_enforce_if(present)
            self.model.add(shift == 0).only_enforce_if(~present)
            shifts.append(shift)
        self._terms = Terms(travel, delays, switched, near_switched, predecessor_changes, shifts, shortfalls)
        return self._terms

    def assignment(self, solver: cp.CpSolver) -> frozenset[tuple[str, str]]:
        return frozenset(key for key, choice in self.choices.items() if solver.boolean_value(choice))

    def require_difference(self, chosen: frozenset[tuple[str, str]]) -> cp.IntVar:
        """Optional cut: at least one task on a different vehicle; active only while assumed."""
        switch = self.model.new_bool_var(f"differs_{len(self.model.proto.constraints)}")
        self.model.add(sum(self.choices[key] for key in chosen) <= len(chosen) - 1).only_enforce_if(switch)
        return switch

    def candidate(self, solver: cp.CpSolver, strategy: Strategy, coverage_proven: bool,
                  elapsed_ms: int, status: str) -> PlanCandidate:
        assignments = dict(self.state.frozen)
        for (vehicle, origin, target), (literal, seconds) in self.arcs.items():
            if target is None or not solver.boolean_value(literal):
                continue
            source = delivery(origin) if origin is not None else self.state.anchors[vehicle].node
            meters = transport_distance(self.state.travel, source, target)
            fixed = self.state.frozen.get(target)
            if fixed is not None:
                if meters is not None:
                    assignments[target] = fixed.model_copy(update={"distance_meters": meters})
                continue
            times = self.times[target]
            start = solver.value(times.pickup)
            assignments[target] = Assignment(
                task_id=target, vehicle_id=vehicle, planned_departure=solver.value(times.departure),
                planned_pickup=start, planned_dropoff=start + times.to_dropoff,
                planned_end=start + times.to_end, deadhead=seconds,
                distance_meters=meters,
            )
        ordered = sorted(assignments.values(), key=lambda row: (row.vehicle_id, row.planned_departure, row.task_id))
        validation = validate_plan(self.state, ordered)
        if any(issue not in self.state.blocking for issue in validation):
            return PlanCandidate(None, "VALIDATION_FAILED")
        result, changes = metrics(self.state, ordered)
        return PlanCandidate(Candidate(
            strategy=strategy, assignments=ordered, unassigned=[
                explain(self.state, key, ordered) for key in self.state.tasks if key not in assignments
            ], blocking=validation, metrics=result, changes=changes, solver_status=status,
            coverage_proven=coverage_proven, solve_ms=elapsed_ms,
            released_task_ids=sorted(key for key, row in self.state.previous.items()
                                     if row.status == "IN_PROGRESS" and key not in self.state.frozen),
        ), status)


def _solve(model: cp.CpModel, seconds: float, hint: cp.CpSolver | None = None,
           assume: list[cp.IntVar] | None = None) -> tuple[cp.CpSolver, str]:
    if hint is not None:
        for index in range(len(hint.response_proto.solution)):
            variable = model.get_int_var_from_proto_index(index)
            model.add_hint(variable, hint.value(variable))
    if assume:
        model.add_assumptions(assume)
    solver = cp.CpSolver()
    solver.parameters.num_workers = 1
    solver.parameters.random_seed = 42
    solver.parameters.max_time_in_seconds = seconds
    solver.parameters.max_deterministic_time = seconds / 4
    status = solver.solve(model)
    model.clear_hints()
    model.clear_assumptions()
    return solver, solver.status_name(status)


def _score(state: PlanningSnapshot, plan: Candidate) -> tuple[int, ...]:
    """Lower is better on every axis; used to drop alternatives that no dispatcher would pick."""
    unassigned = sum({"P1": 1_000_000, "P2": 1_000, "P3": 1}[state.tasks[issue.task_id].priority]
                     for issue in plan.unassigned)
    delay = sum(PRIORITY_WEIGHT[state.tasks[row.task_id].priority]
                * max(0, row.planned_pickup - state.tasks[row.task_id].earliest_pickup)
                for row in plan.assignments)
    return (unassigned, delay, plan.metrics.vehicle_changes, -plan.metrics.min_buffer_seconds,
            plan.metrics.travel_seconds)


# Differences below these amounts (unassigned weight, weighted delay s, changes, buffer s, travel s) are noise.
TOLERANCE = (0, 120, 0, 300, 300)


def _dominated(score: tuple[int, ...], others: list[tuple[int, ...]]) -> bool:
    return any(all(a <= b + tol for a, b, tol in zip(other, score, TOLERANCE))
               and any(a < b - tol for a, b, tol in zip(other, score, TOLERANCE)) for other in others)


class CpSatPlanner:
    def solve(self, snapshot: PlanningSnapshot, strategy: Strategy, budget: SolveBudget) -> PlanCandidate:
        return self.alternatives(snapshot, (strategy,), budget)[0]

    @staticmethod
    def _prepare(schedule: ScheduleModel, budget: SolveBudget):
        """Red first, then coverage, then (soft windows only) the smallest overrun; each result is locked."""
        hint = None
        if schedule.urgent is not None:
            schedule.model.minimize(schedule.urgent)
            hint, status = _solve(schedule.model, budget.coverage_seconds)
            if status not in ("OPTIMAL", "FEASIBLE"):
                return status
            schedule.model.add(schedule.urgent == hint.value(schedule.urgent))
        schedule.model.maximize(schedule.coverage)
        coverage_solver, coverage_status = _solve(schedule.model, budget.coverage_seconds, hint)
        if coverage_status not in ("OPTIMAL", "FEASIBLE"):
            if hint is None:
                return coverage_status
            coverage_solver, coverage_status = hint, status
            coverage_proven = False
        else:
            coverage_proven = coverage_status == "OPTIMAL"
        schedule.model.add(schedule.coverage == coverage_solver.value(schedule.coverage))
        if schedule.overrun is not None:
            schedule.model.minimize(schedule.overrun)
            shifted, shifted_status = _solve(schedule.model, budget.strategy_seconds, coverage_solver)
            if shifted_status in ("OPTIMAL", "FEASIBLE"):
                schedule.model.add(schedule.overrun <= round(shifted.objective_value))
                coverage_solver, coverage_status = shifted, shifted_status
        return coverage_solver, coverage_status, coverage_proven

    def alternatives(self, snapshot: PlanningSnapshot, strategies: tuple[Strategy, ...] = STRATEGIES,
                     budget: SolveBudget = SolveBudget()) -> list[PlanCandidate]:
        started = monotonic()
        # Hard windows keep the model small and provably optimal; soft windows are used only when a task
        # would otherwise be dropped, so no task is ever left out just because its window cannot be met.
        schedule = ScheduleModel(snapshot)
        prepared = self._prepare(schedule, budget)
        complete = not isinstance(prepared, str) and not schedule.window_dropped and all(
            prepared[0].boolean_value(present) for present in schedule.present.values())
        if not complete:
            soft = ScheduleModel(snapshot, soft_windows=True)
            soft_prepared = self._prepare(soft, budget)
            if not isinstance(soft_prepared, str) and (isinstance(prepared, str) or soft_prepared[0].value(
                    soft.coverage) > prepared[0].value(schedule.coverage)):
                schedule, prepared = soft, soft_prepared
        if isinstance(prepared, str):
            return [PlanCandidate(None, prepared)]
        coverage_solver, coverage_status, coverage_proven = prepared
        output: list[PlanCandidate] = []
        found: list[frozenset[tuple[str, str]]] = []
        scores: list[tuple[int, ...]] = []
        for strategy in strategies:
            strategy_start = monotonic()
            schedule.set_objective(strategy)
            solver, status = _solve(schedule.model, budget.strategy_seconds, coverage_solver)
            if status in ("OPTIMAL", "FEASIBLE") and schedule.assignment(solver) in found:
                if not schedule.choices:
                    break
                cuts = [schedule.require_difference(chosen) for chosen in found if chosen]
                solver, status = _solve(schedule.model, budget.strategy_seconds, assume=cuts)
            if status not in ("OPTIMAL", "FEASIBLE"):
                if output:
                    output.append(PlanCandidate(None, status))
                    continue
                solver, status = coverage_solver, coverage_status
            elapsed = monotonic() - (strategy_start if output else started)
            candidate = schedule.candidate(solver, strategy, coverage_proven, round(elapsed * 1000), status)
            if candidate.plan and output:
                score = _score(snapshot, candidate.plan)
                if _dominated(score, scores):
                    output.append(PlanCandidate(None, "DOMINATED"))
                    continue
            output.append(candidate)
            if candidate.plan:
                found.append(schedule.assignment(solver))
                scores.append(_score(snapshot, candidate.plan))
        return output
