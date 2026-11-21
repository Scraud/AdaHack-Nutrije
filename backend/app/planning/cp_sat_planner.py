from dataclasses import dataclass
from time import monotonic

from ortools.sat.python import cp_model as cp

from app.planning.contracts import (
    Assignment, Candidate, HORIZON, PlanCandidate, PlanningSnapshot, SolveBudget, Strategy,
)
from app.planning.snapshot_builder import compatible, delivery, facility_remaining, pickup, transport_distance
from app.planning.validator import validate_plan
from app.services.metrics import explain, metrics, predecessors

STRATEGIES: tuple[Strategy, ...] = ("MIN_DELAY", "MIN_CHANGES", "MAX_BUFFER")
Arc = tuple[str, str | None, str | None]


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
    def __init__(self, state: PlanningSnapshot):
        self.state = state
        self.model = cp.CpModel()
        self.times: dict[str, Times] = {}
        self.choices: dict[tuple[str, str], cp.IntVar] = {}
        self.arcs: dict[Arc, tuple[cp.IntVar, int]] = {}
        self.present: dict[str, cp.IntVar] = {}
        self.min_buffer = self.model.new_int_var(0, HORIZON, "min_buffer")
        self._add_tasks()
        self._add_routes()
        base = len(state.tasks) + 1
        weights = {"P1": base * base, "P2": base, "P3": 1}
        self.coverage = sum(weights[state.tasks[key].priority] * present
                            for key, present in self.present.items() if key not in state.frozen)

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
            upper = min(task.latest_pickup if task.latest_pickup is not None else HORIZON,
                        task.latest_arrival - to_dropoff, HORIZON - to_end)
            lower = max(task.earliest_pickup, self.state.now)
            if upper < lower and fixed is None:
                continue
            model = self.model
            if fixed:
                lower = upper = fixed.planned_pickup
            times = Times(
                model.new_int_var(self.state.now, HORIZON, f"departure_{key}"),
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
                model.add(self.min_buffer <= times.latest - times.pickup).only_enforce_if(present)
                model.add(times.pickup == lower).only_enforce_if(~present)
        for facility in self.state.facilities.values():
            arrivals = [present for key, present in self.present.items()
                        if self.state.tasks[key].facility_id == facility.id and key not in self.state.frozen]
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
        travel = sum(edge * seconds for edge, seconds in self.arcs.values())
        travel += sum(self.present[key] * times.loaded for key, times in self.times.items())
        delays = []
        shifts = []
        switched = []
        predecessor_changes = []
        previous = predecessors(list(self.state.previous.values()))
        for key, times in self.times.items():
            if key in self.state.frozen:
                continue
            task = self.state.tasks[key]
            present = self.present[key]
            delay = self.model.new_int_var(0, HORIZON, f"delay_{key}")
            self.model.add(delay >= times.pickup + times.to_dropoff - task.preferred_arrival).only_enforce_if(present)
            self.model.add(delay == 0).only_enforce_if(~present)
            delays.append(delay * (4 if task.priority == "P1" else 1))
            old = self.state.previous.get(key)
            if old is None:
                continue
            same_vehicle = self.choices.get((old.vehicle_id, key), 0)
            switched.append(1 - same_vehicle)
            same_predecessor = self.arcs.get((old.vehicle_id, previous[key], key))
            barrier = self.state.frozen.get(previous[key]) if previous[key] is not None else None
            if (same_predecessor is None and barrier and barrier.status != "PLANNED"
                and self.state.anchors[old.vehicle_id].node == delivery(barrier.task_id)):
                same_predecessor = self.arcs.get((old.vehicle_id, None, key))
            if same_predecessor is not None:
                predecessor_changes.append(1 - same_predecessor[0])
            shift = self.model.new_int_var(0, HORIZON, f"shift_{key}")
            self.model.add(shift >= times.pickup - old.planned_pickup).only_enforce_if(present)
            self.model.add(shift >= old.planned_pickup - times.pickup).only_enforce_if(present)
            self.model.add(shift == 0).only_enforce_if(~present)
            shifts.append(shift)
        if strategy == "MIN_CHANGES":
            self.model.minimize(1_000_000_000 * sum(switched) + 10_000_000 * sum(predecessor_changes)
                                + 4 * sum(shifts) + sum(delays) + travel)
        elif strategy == "MAX_BUFFER":
            self.model.minimize(-1_000_000 * self.min_buffer + sum(delays) * 3 + travel)
        else:
            self.model.minimize(20 * sum(delays) + travel + sum(times.pickup for times in self.times.values()))

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
                explain(self.state, key) for key in self.state.tasks if key not in assignments
            ], blocking=validation, metrics=result, changes=changes, solver_status=status,
            coverage_proven=coverage_proven, solve_ms=elapsed_ms,
        ), status)


def _solve(model: cp.CpModel, seconds: float) -> tuple[cp.CpSolver, str]:
    solver = cp.CpSolver()
    solver.parameters.num_workers = 1
    solver.parameters.random_seed = 42
    solver.parameters.max_time_in_seconds = seconds
    solver.parameters.max_deterministic_time = seconds / 4
    status = solver.solve(model)
    return solver, solver.status_name(status)


class CpSatPlanner:
    def solve(self, snapshot: PlanningSnapshot, strategy: Strategy, budget: SolveBudget) -> PlanCandidate:
        return self.alternatives(snapshot, (strategy,), budget)[0]

    def alternatives(self, snapshot: PlanningSnapshot, strategies: tuple[Strategy, ...] = STRATEGIES,
                     budget: SolveBudget = SolveBudget()) -> list[PlanCandidate]:
        started = monotonic()
        schedule = ScheduleModel(snapshot)
        schedule.model.maximize(schedule.coverage)
        coverage_solver, coverage_status = _solve(schedule.model, budget.coverage_seconds)
        if coverage_status not in ("OPTIMAL", "FEASIBLE"):
            return [PlanCandidate(None, coverage_status)]
        schedule.model.add(schedule.coverage == round(coverage_solver.objective_value))
        output = []
        coverage_proven = coverage_status == "OPTIMAL"
        for strategy in strategies:
            strategy_start = monotonic()
            schedule.set_objective(strategy)
            if not output:
                for index in range(len(coverage_solver.response_proto.solution)):
                    variable = schedule.model.get_int_var_from_proto_index(index)
                    schedule.model.add_hint(variable, coverage_solver.value(variable))
            solver, status = _solve(schedule.model, budget.strategy_seconds)
            schedule.model.clear_hints()
            if status not in ("OPTIMAL", "FEASIBLE"):
                if output:
                    output.append(PlanCandidate(None, status))
                    continue
                solver, status = coverage_solver, coverage_status
            elapsed = monotonic() - (strategy_start if output else started)
            candidate = schedule.candidate(solver, strategy, coverage_proven, round(elapsed * 1000), status)
            output.append(candidate)
            chosen = [edge for edge, _ in schedule.arcs.values() if solver.boolean_value(edge)]
            if candidate.plan and chosen:
                schedule.model.add(sum(chosen) < len(chosen))
            elif candidate.plan:
                break
        return output
