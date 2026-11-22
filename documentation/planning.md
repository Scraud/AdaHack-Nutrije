# Planning — CP-SAT Scheduler

The scheduler is the brain of RescueFlow. Given a set of vehicles, tasks, and a travel time matrix, it produces a provably-optimal (or near-optimal) assignment of tasks to vehicles and schedules pickup times. It uses Google OR-Tools CP-SAT, a constraint programming solver with SAT-based propagation.

---

## Files

| File | Purpose |
|---|---|
| `app/planning/contracts.py` | All domain types used by the solver |
| `app/planning/cp_sat_planner.py` | The CP-SAT model: `ScheduleModel` and `CpSatPlanner` |
| `app/planning/snapshot_builder.py` | Assembles `PlanningSnapshot` from raw DB entities |
| `app/planning/validator.py` | Post-solve constraint checker |

---

## Domain Types (contracts.py)

The solver works exclusively with frozen, validated Pydantic/dataclass objects — it never touches the database directly.

**Key types:**

- `Vehicle` — id, location, capacity, equipment list, task_types, available_at, broken, unavailable windows
- `Task` — id, type (PLANNED_TRANSPORT / PRIORITY_TRANSPORT / EQUIPMENT_DELIVERY), priority (P1/P2/P3), pickup location, facility_id, passenger_count, equipment, time windows (earliest_pickup, latest_pickup, preferred_arrival, latest_arrival), service durations
- `Facility` — id, name, location, quota (capacity remaining), accepting flag
- `Assignment` — task_id, vehicle_id, planned_departure, planned_pickup, planned_dropoff, planned_end, deadhead (travel to pickup in seconds), status, distance_meters
- `TravelSnapshot` — a frozen N×N matrix of travel durations (and optionally distances) between all nodes (vehicle starts, pickups, deliveries)
- `PlanningSnapshot` — the complete input to the solver: now, vehicles, tasks, facilities, previous assignments, frozen assignments, anchors, travel matrix, blocking issues

**Time representation:** all times are integers in seconds since the scenario start (08:00). The day horizon `HORIZON = 36000` seconds (10 hours → 18:00).

---

## PlanningSnapshot — `snapshot_builder.py`

Before the solver runs, `build_snapshot()` constructs a `PlanningSnapshot`:

1. Collects all entities from DB.
2. Determines each vehicle's current **anchor** — where it is right now and when it will be free — based on its last completed or in-progress assignment.
3. Builds the **travel matrix** by calling either `RoadMatrix` (OSRM) or `RoadNetwork` (OSM graph) with all relevant nodes (vehicle anchors, task pickups, facility delivery points).
4. Identifies **frozen assignments** (IN_PROGRESS or COMPLETED tasks that cannot be rescheduled).
5. Identifies **blocked tasks** from `validate_plan` (tasks that cannot proceed due to breakdowns, closures, etc.) and stores them as `blocking`.

---

## The CP-SAT Model — `ScheduleModel`

The model is built fresh for each solve call. It encodes the Vehicle Routing Problem with Time Windows (VRPTW) as a CP-SAT integer program.

### Variables

For each **task** (that is schedulable):
- `departure_{key}` — integer: when the vehicle departs towards the pickup
- `pickup_{key}` — integer: when the vehicle arrives at pickup (constrained to [earliest_pickup, latest_pickup])
- `latest_{key}` — integer: latest possible pickup time (used to compute schedule buffer)
- `scheduled_{key}` — boolean: whether this task is included in the solution

For each **(vehicle, task)** pair:
- `choice_{vehicle}_{task}` — boolean: is this task assigned to this vehicle?

For each **arc** (edge in the route graph):
- `arc_{vehicle}_{origin}_{target}` — boolean: is this sequence edge active?

### Coverage Objective (Phase 1)

The model first maximises **coverage** — the weighted count of scheduled tasks:

```
P1 tasks have weight base²
P2 tasks have weight base
P3 tasks have weight 1
(where base = num_tasks + 1)
```

This guarantees that high-priority tasks are always scheduled before lower-priority ones. The solver runs for up to `coverage_seconds` (default 3 s).

### Strategy Objectives (Phase 2)

Once maximum coverage is locked in (by adding a constraint `coverage == optimal_value`), the model is re-solved for each of three **strategies**, each for up to `strategy_seconds` (default 2 s):

| Strategy | Objective |
|---|---|
| `MIN_DELAY` | Minimise total weighted delay past preferred_arrival, plus travel time and earliest pickup |
| `MIN_CHANGES` | Minimise vehicle reassignments, then sequence changes, then time shifts (suitable for re-planning) |
| `MAX_BUFFER` | Maximise the minimum slack buffer across all tasks (most robust schedule) |

The solver uses the coverage solution as a **warm start hint** for all strategy solves.

### Circuit Constraint

Each vehicle's route is modelled as a **Hamiltonian circuit** using `add_circuit()`. Each task is a node; arcs represent "vehicle goes from task A's delivery point to task B's pickup". A self-loop on a task means it is not visited by this vehicle. An empty-vehicle arc means the vehicle takes no tasks.

This directly encodes the routing constraint: each task is visited by at most one vehicle, and within a vehicle tasks must be sequenced consistently.

### Time Window Propagation

For each arc from origin to target:
```
target.departure = max(anchor.time, origin.pickup + origin.to_end)
target.pickup = target.departure + deadhead(origin_delivery → target_pickup)
```

This ensures travel time is respected and vehicles cannot teleport. Infeasible arcs (where the earliest possible arrival exceeds `latest_pickup`) are pruned before the model is built.

### Facility Capacity

For each facility, the number of non-frozen tasks assigned to it is constrained to `≤ facility.quota`. This prevents overcrowding a care centre.

### Vehicle Unavailability

For each `(begin, end)` unavailability window on a vehicle, the model ensures the task either ends before `begin` or starts after `end`. Modelled with an auxiliary boolean (`before`) that selects which side of the window the task falls on.

---

## Solver Execution — `CpSatPlanner`

```python
# Phase 1: maximise coverage
schedule.model.maximize(coverage)
coverage_solver, status = _solve(model, budget.coverage_seconds)

# Lock coverage
schedule.model.add(coverage == round(coverage_solver.objective_value))

# Phase 2: one solve per strategy
for strategy in strategies:
    schedule.set_objective(strategy)
    solver, status = _solve(model, budget.strategy_seconds)
    candidate = schedule.candidate(solver, strategy, ...)
```

The solver is deterministic (`random_seed = 42`) and single-threaded (`num_workers = 1`).

After each strategy solve, the model adds a **diversity constraint** (`sum(active_arcs) < count`), which forces subsequent strategies to find a structurally different route layout. This ensures the three recommendations shown to the dispatcher are meaningfully distinct.

---

## Validation — `validator.py`

After the solver returns a solution, `validate_plan` rechecks all assignments against:
- Vehicle broken / unavailable at task time
- Road closure or traffic delay (checks whether the planned timing still fits)
- Facility not accepting

Issues found here become `blocking` — these tasks are shown as "at risk" in the dashboard. The solve result is accepted even with blocking issues (they were pre-existing in the snapshot); only *new* blocking issues introduced by the solution cause it to be discarded.
