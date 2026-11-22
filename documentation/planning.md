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
- `Task` — id, type (PLANNED_TRANSPORT / PRIORITY_TRANSPORT / EQUIPMENT_DELIVERY), priority (P1/P2/P3), pickup location, facility_id, passenger_count, equipment, pickup window (`earliest_pickup` = desired pickup, `latest_pickup` derived from priority), service durations
- `Facility` — id, name, location, quota (capacity remaining), accepting flag
- `Assignment` — task_id, vehicle_id, planned_departure, planned_pickup, planned_dropoff, planned_end, deadhead (travel to pickup in seconds), status, distance_meters, reroute (automatic detour after a road event)
- `TravelSnapshot` — a frozen N×N matrix of travel durations (and optionally distances) between all nodes (vehicle starts, pickups, deliveries)
- `PlanningSnapshot` — the complete input to the solver: now, vehicles, tasks, facilities, previous assignments, frozen assignments, anchors, travel matrix, blocking issues

**Time representation:** all times are integers in seconds since the scenario start (08:00). The day horizon `HORIZON = 36000` seconds (10 hours → 18:00).

---

## PlanningSnapshot — `snapshot_builder.py`

Before the solver runs, `build_snapshot()` constructs a `PlanningSnapshot`:

1. Collects all entities from DB.
2. Determines each vehicle's current **anchor** — where it is right now and when it will be free — based on its last completed or in-progress assignment.
3. Builds the **travel matrix** by calling either `RoadMatrix` (OSRM) or `RoadNetwork` (OSM graph) with all relevant nodes (vehicle anchors, task pickups, facility delivery points).
4. Freezes completed and locked assignments and ongoing transports. When an immediate high-priority task is waiting, an unlocked trip to a lower-priority pickup can be replanned from the vehicle's simulated position. This position takes effect when the dispatcher accepts a proposal.
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

### Priority Rules and Coverage Objectives

Each task has a **desired pickup** (`earliest_pickup`) and a **latest pickup** derived from its priority (`MAX_WAIT` in `contracts.py`, enforced by a model validator so stored or submitted values cannot drift):

| Priority | Latest pickup | Treatment |
|---|---|---|
| P1 (Visoka, red) | none | As soon as possible, absolute priority |
| P2 (Srednja) | desired + 45 min | Hard window |
| P3 (Nizka) | desired + 2 h | Hard window |

There are no hospital arrival targets or deadlines; a pickup's upper bound is only `latest_pickup` and the end of the day. "Delay" everywhere means waiting after the desired pickup.

**P1 absolute priority:** the model first maximises the number of assigned P1 tasks and then minimises their total waiting time; that result is locked before anything else is optimised. It then maximises **coverage**, the weighted count of scheduled tasks:

```
P1 tasks have weight base²
P2 tasks have weight base
P3 tasks have weight 1
(where base = num_tasks + 1)
```

The weights prioritise the number of high-priority assignments. The urgent and coverage solves each run for up to `coverage_seconds` (default 3 s). P2/P3 waiting is then traded by the strategies within the hard windows.

### Strategy Objectives

Once maximum coverage is locked in (by adding a constraint `coverage == optimal_value`), the model is re-solved for each of three **strategies**, each for up to `strategy_seconds` (default 2 s).

All three strategies minimise **the same cost model**, expressed in *minutes of P3 delay*. Each strategy only changes the rates (`PROFILES` in `cp_sat_planner.py`), so every alternative is a sensible restructure rather than an extreme:

| Criterion | What is counted | `MIN_DELAY` | `MIN_CHANGES` | `MAX_BUFFER` |
|---|---|---|---|---|
| Waiting | Minutes between desired and planned pickup, × P2 3 / P3 1 (P1 is already locked) | 1 | 1 | 0.5 |
| Vehicle swap | Task moved to another vehicle (crew must be told) | 3 | 30 | 6 |
| Urgent swap (extra) | Swap of a task departing within 60 min of now | +3 | +15 | +6 |
| Route-order change | Task gets a different predecessor | 0.5 | 6 | 1 |
| Pickup shift | Per minute the pickup moves | 0.05 | 0.25 | 0.05 |
| Buffer shortfall | Per minute any task's buffer is below 20 min | 0.1 | 0.1 | 1.5 (+ reward for the smallest buffer) |
| Driving | Per minute of driving | 0.05 | 0.02 | 0.02 |

How to read the table: with `MIN_DELAY` a vehicle swap is worth it if it saves at least 3 min of P3 delay (45 s of P1 delay). With `MIN_CHANGES` it must save at least 30 min of P3 delay (7.5 min of P1), or more if the task departs within the hour. Before this change, `MIN_CHANGES` used lexicographic weights (one swap = 10⁹), so it accepted any amount of delay to avoid a single swap. `MIN_DELAY` had no change cost at all, so it could move 10 tasks to other vehicles to save one minute.

Every strategy solve is warm-started from the coverage solution.

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

**Display order:** alternatives are always listed as `MIN_DELAY` → `MAX_BUFFER` → `MIN_CHANGES`; the fewest-changes option is last. The backend sorts both the generate response and `GET /api/recommendations` (`STRATEGY_ORDER` in `services/planning.py`), and the frontend store sorts the same way (`STRATEGY_ORDER` in `plan-utils.ts`).

**Choosing which alternatives to show:**

1. Each strategy is solved **independently** on the same model, so no strategy is degraded by the ones before it. Previously, every later strategy had to differ from earlier ones by at least one route arc. That forced `MIN_CHANGES` and `MAX_BUFFER` into worse plans, often with *more* vehicle swaps than `MIN_DELAY`.
2. If a strategy lands on a vehicle assignment that was already found, it is re-solved with a temporary cut (`require_difference`, applied through CP-SAT *assumptions* and removed afterwards) that moves at least one task to a different vehicle.
3. A candidate is **dropped as `DOMINATED`** if an already accepted alternative is no worse on every axis and clearly better on at least one. The axes are: priority-weighted unassigned tasks, priority-weighted delay, vehicle swaps, smallest buffer and driving time. Differences below `TOLERANCE` (2 min weighted delay, 5 min buffer, 5 min driving) count as ties, so a 1-minute buffer gain does not justify an extra swap.

As a result, the dispatcher sees one to three genuinely different trade-offs. When one plan is best on everything (e.g. a single breakdown with plenty of slack), only that plan is shown. `backend/tests/test_recommendation_quality.py` checks that there are no mass reshuffles for tiny gains, that alternatives are distinct and not dominated, and that `MIN_CHANGES` swaps fewer vehicles than `MIN_DELAY` when both are shown.

---

## Validation — `validator.py`

After the solver returns a solution, `validate_plan` rechecks all assignments against:
- Vehicle broken / unavailable at task time
- Road closure or traffic delay (checks whether the planned timing still fits)
- Facility not accepting

Issues found here become `blocking` — these tasks are shown as "at risk" in the dashboard. The solve result is accepted even with blocking issues (they were pre-existing in the snapshot); only *new* blocking issues introduced by the solution cause it to be discarded.
