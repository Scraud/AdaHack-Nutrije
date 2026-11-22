import json
import os
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from threading import Lock
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.schemas import Baseline, Explanation, Flag, PlanView, TaskImpact
from app.models import Plan, Recommendation, Scenario
from app.planning.contracts import Assignment, Incident, PlanningSnapshot, Task
from app.planning.snapshot_builder import MatrixProvider, routes
from app.providers.roads import active_conditions, road_network
from app.services.state import baseline, inputs, problem, view_plan

try:
    LJUBLJANA = ZoneInfo("Europe/Ljubljana")
except ZoneInfoNotFoundError:
    LJUBLJANA = timezone(timedelta(hours=1))

STRATEGY_NAMES = {"MIN_DELAY": "Najmanj zamud", "MIN_CHANGES": "Najmanj sprememb", "MAX_BUFFER": "Največ rezerve"}
ISSUE_NAMES = {
    "VEHICLE_UNAVAILABLE": "vozilo ni operativno",
    "NO_COMPATIBLE_VEHICLE": "ni vozila z ustrezno opremo",
    "UNREACHABLE_ROUTE": "relacija je nedosegljiva",
    "HARD_TIME_WINDOW": "obveznega časovnega okna ni mogoče ohraniti",
    "INVALID_TRAVEL_TIME": "motnja je spremenila čas vožnje",
    "FACILITY_NOT_ACCEPTING": "ustanova ne sprejema prihodov",
    "FACILITY_CAPACITY": "kvota ustanove je porabljena",
    "LOCKED_EXECUTION_BLOCKED": "začeta dodelitev je blokirana",
    "NOT_SCHEDULED_WITHIN_BUDGET": "izračun naloge ni umestil v razpored",
}
SEVERITY = {"HIGH": 0, "MEDIUM": 1, "INFO": 2}
TIGHT_P1 = 600
TIGHT = 300
CASCADE_SLACK = 180
CASCADE_MARGIN = 900
BUNCHING_WINDOW = 300
LATE_STEP = 300
MAX_ITEMS = 3
MAX_WORDS = 10
IDENTIFIER = re.compile(r"\b[TVF]\d{1,3}\b")
METRIC_CHANGE = re.compile(r"\b(zamuda|rezerva|vožnja)\b\D{0,12}?([+−-])\s?\d", re.IGNORECASE)

SYSTEM_PROMPT = """Si svetovalec dispečerju nenujnih reševalnih prevozov v Ljubljani.
Optimizator je izračunal predlog spremembe razporeda. Odloča dispečer, ne ti.
Dispečer ima le nekaj sekund, zato mora biti odgovor izjemno kratek.

Dobil boš JSON z dejstvi:
- "computed_pros" in "computed_cons": preverjene prednosti in slabosti potrditve predloga.
- "active_plan_vs_proposal": primerjava aktivnega plana in predloga; smer je že izračunana, ne računaj sam.
- "active_disruptions": motnje, ki veljajo za oba plana.

Vrni:
- "pros": največ 3 najpomembnejše prednosti potrditve predloga.
- "cons": največ 3 najpomembnejše slabosti ali tveganja potrditve predloga.

Pravila:
- Vsaka alineja ima največ 8 besed. Brez uvodov, brez celih stavkov, slog alinej, npr. "Zamuda +11 min".
- Izhajaj iz "computed_pros" in "computed_cons": izberi najpomembnejše, lahko jih skrajšaš ali združiš.
- Tveganja za naloge P1 so vedno med slabostmi, če obstajajo.
- Uporabljaj SAMO podatke iz JSON. Ne izmišljuj si nalog, vozil, ustanov ali številk.
- Oznake (npr. T07, V2, F1) prepiši točno tako, kot so v podatkih.
- Ne priporočaj, ali naj dispečer predlog potrdi."""

NARRATIVE_SCHEMA = {
    "type": "object",
    "properties": {
        "pros": {"type": "array", "items": {"type": "string"}, "maxItems": MAX_ITEMS},
        "cons": {"type": "array", "items": {"type": "string"}, "maxItems": MAX_ITEMS},
    },
    "required": ["pros", "cons"],
}


class Narrative(BaseModel):
    pros: list[str] = Field(default_factory=list)
    cons: list[str] = Field(default_factory=list)


def minutes(seconds: int) -> int:
    return round(seconds / 60)


def signed(value: int, unit: str = "") -> str:
    return f"{value:+d}{unit}".replace("-", "−")


def margin(task: Task, row: Assignment) -> int:
    values = [task.latest_arrival - row.planned_dropoff]
    if task.latest_pickup is not None:
        values.append(task.latest_pickup - row.planned_pickup)
    return min(values)


def delay(task: Task, row: Assignment) -> int:
    return max(0, row.planned_dropoff - task.preferred_arrival)


def recommendation_facts(db: Session, scope: Scenario, rec_id: str,
                         road_matrix: MatrixProvider | None) -> tuple[Explanation, dict]:
    rec = db.get(Recommendation, rec_id)
    if not rec or rec.scenario_id != scope.id:
        raise problem(404, "RECOMMENDATION_NOT_FOUND", "Predlog ne obstaja.")
    if rec.status != "PROPOSED" or rec.base_revision != scope.revision:
        raise problem(409, "STALE_STATE", "Predlog ni več aktualen. Ustvarite nove predloge.")
    base = db.get(Plan, rec.base_plan_id)
    proposal = view_plan(db, db.get(Plan, rec.proposed_plan_id))
    state, incidents, base_rows = inputs(db, scope, base, road_matrix, preserve_active_timing=True)
    return analyse(rec.id, scope.start_at, state, incidents, base_rows, baseline(state, base_rows), proposal)


def analyse(rec_id: str, start_at: str, state: PlanningSnapshot, incidents: list[Incident],
            base_rows: list[Assignment], current: Baseline, proposal: PlanView) -> tuple[Explanation, dict]:
    origin = datetime.fromisoformat(start_at)

    def at(seconds: int) -> str:
        return (origin + timedelta(seconds=seconds)).astimezone(LJUBLJANA).strftime("%H:%M")

    tasks = state.tasks
    old = {row.task_id: row for row in base_rows}
    new = {row.task_id: row for row in proposal.assignments}
    blocked_now = {issue.task_id for issue in current.affected}
    upcoming = [row for row in proposal.assignments if row.status == "PLANNED" and not row.is_locked]
    flags: list[Flag] = []

    for issue in proposal.unassigned:
        task = tasks[issue.task_id]
        flags.append(Flag(code="UNASSIGNED", severity="HIGH" if task.priority == "P1" else "MEDIUM",
                          message=f"{task.id} ({task.priority}) ostane brez vozila: "
                                  f"{ISSUE_NAMES.get(issue.code, issue.code)}.",
                          short=f"{task.id} ({task.priority}) brez vozila", task_ids=[task.id]))

    resolved = sorted(task_id for task_id in blocked_now if task_id in new)
    if resolved:
        flags.append(Flag(code="RESOLVED", severity="INFO", task_ids=resolved,
                          short=f"Izvede {', '.join(resolved)}",
                          message="Predlog izvede naloge, ki jih aktivni plan ob trenutnih razmerah ne more: "
                                  f"{', '.join(resolved)}."))

    swaps = [change for change in proposal.changes
             if change.old_vehicle_id and change.new_vehicle_id and change.old_vehicle_id != change.new_vehicle_id]
    if swaps:
        flags.append(Flag(
            code="CREW_NOTICE", severity="INFO", task_ids=[change.task_id for change in swaps],
            vehicle_ids=sorted({v for change in swaps for v in (change.old_vehicle_id, change.new_vehicle_id)}),
            short=f"Menjave vozil: {len(swaps)} – obvesti posadke",
            message="Zamenjava vozila: " + ", ".join(
                f"{change.task_id} {change.old_vehicle_id}→{change.new_vehicle_id}" for change in swaps
            ) + ". Posadke je treba obvestiti.",
        ))

    cascaded = set()
    for vehicle_id, route in routes(proposal.assignments).items():
        for before, after in zip(route, route[1:]):
            if before.status == "COMPLETED" or after.status != "PLANNED" or after.is_locked:
                continue
            task = tasks[after.task_id]
            slack = after.planned_pickup - after.deadhead - before.planned_end
            left = margin(task, after)
            if slack < CASCADE_SLACK and left < CASCADE_MARGIN:
                cascaded.add(task.id)
                flags.append(Flag(
                    code="CASCADE", severity="HIGH" if task.priority == "P1" else "MEDIUM",
                    task_ids=[before.task_id, task.id], vehicle_ids=[vehicle_id],
                    short=f"Zamuda {before.task_id} → {task.id} ({task.priority}), rezerva {minutes(left)} min",
                    message=f"{vehicle_id}: zamuda pri {before.task_id} se neposredno prenese na {task.id} "
                            f"({task.priority}), ki ima do roka le {minutes(left)} min rezerve.",
                ))

    for row in upcoming:
        task = tasks[row.task_id]
        left = margin(task, row)
        if task.id not in cascaded and left < (TIGHT_P1 if task.priority == "P1" else TIGHT):
            flags.append(Flag(code="TIGHT_DEADLINE", severity="HIGH" if task.priority == "P1" else "MEDIUM",
                              task_ids=[task.id], vehicle_ids=[row.vehicle_id],
                              short=f"{task.id} ({task.priority}) le {minutes(left)} min do roka",
                              message=f"{task.id} ({task.priority}, {row.vehicle_id}) ima do obveznega roka "
                                      f"le {minutes(left)} min rezerve."))
        previous = old.get(task.id)
        if task.id in blocked_now:
            continue
        before_delay = delay(task, previous) if previous else 0
        after_delay = delay(task, row)
        if after_delay >= before_delay + LATE_STEP:
            flags.append(Flag(code="LATER_ARRIVAL", severity="HIGH" if task.priority == "P1" else "MEDIUM",
                              task_ids=[task.id], vehicle_ids=[row.vehicle_id],
                              short=f"{task.id} ({task.priority}) zamudi {minutes(after_delay)} min",
                              message=f"{task.id} ({task.priority}) prispe {minutes(after_delay)} min za želenim "
                                      f"časom {at(task.preferred_arrival)} (v aktivnem planu "
                                      f"{minutes(before_delay)} min)."))

    arrivals: dict[str, list[Assignment]] = defaultdict(list)
    for row in upcoming:
        arrivals[tasks[row.task_id].facility_id].append(row)
    for facility_id, rows in sorted(arrivals.items()):
        rows.sort(key=lambda row: row.planned_dropoff)
        group: list[Assignment] = []
        for i, first in enumerate(rows):
            window = [row for row in rows[i:] if row.planned_dropoff - first.planned_dropoff <= BUNCHING_WINDOW]
            if len({row.vehicle_id for row in window}) > len({row.vehicle_id for row in group}):
                group = window
        vehicles = sorted({row.vehicle_id for row in group})
        if len(vehicles) >= 2:
            facility = state.facilities[facility_id]
            flags.append(Flag(
                code="FACILITY_BUNCHING", severity="MEDIUM" if len(vehicles) >= 3 else "INFO",
                task_ids=[row.task_id for row in group], vehicle_ids=vehicles,
                short=f"Gneča v {facility_id}: {len(group)} prihodi v 5 min",
                message=f"{facility.name} ({facility_id}): {len(group)} prihodi med {at(group[0].planned_dropoff)} "
                        f"in {at(group[-1].planned_dropoff)} ({', '.join(vehicles)}). Možna čakalna vrsta ob predaji.",
            ))

    flags.extend(delay_exposure(state, incidents, proposal.assignments))
    flags.sort(key=lambda flag: SEVERITY[flag.severity])

    impacts = []
    for change in proposal.changes:
        task = tasks.get(change.task_id)
        if task is None:
            continue
        row = new.get(task.id)
        impacts.append(TaskImpact(task_id=task.id, priority=task.priority, old_vehicle_id=change.old_vehicle_id,
                                  new_vehicle_id=change.new_vehicle_id, old_pickup=change.old_pickup,
                                  new_pickup=change.new_pickup,
                                  delay_seconds=delay(task, row) if row else None,
                                  margin_seconds=margin(task, row) if row else None))

    before, after = current.metrics, proposal.metrics
    pros: list[str] = []
    cons: list[str] = [flag.short for flag in flags if flag.severity == "HIGH"]
    gained = after.assigned - before.assigned
    if resolved:
        pros.append(f"Izvede {', '.join(resolved)}")
    elif gained > 0:
        pros.append(f"Izvedenih nalog: {signed(gained)}")
    if gained < 0:
        cons.append(f"Izvedenih nalog: {signed(gained)}")
    comparisons = []
    for label, old_value, new_value, higher_is_better in (
        ("Zamuda", minutes(before.delay_seconds), minutes(after.delay_seconds), False),
        ("Rezerva", minutes(before.min_buffer_seconds), minutes(after.min_buffer_seconds), True),
        ("Vožnja", minutes(before.travel_seconds), minutes(after.travel_seconds), False),
    ):
        change = new_value - old_value
        trend = "brez spremembe" if change == 0 else (
            "izboljšanje" if (change > 0) == higher_is_better else "poslabšanje")
        comparisons.append(f"{label}: {old_value} min → {new_value} min ({signed(change, ' min')}, {trend})")
        if change:
            (pros if trend == "izboljšanje" else cons).append(f"{label} {signed(change, ' min')}")
    if after.vehicle_changes == 0:
        pros.append("Brez menjave vozil")
    cons.extend(flag.short for flag in flags
                if flag.severity == "MEDIUM" or flag.code == "CREW_NOTICE")
    pros, cons = unique(pros)[:MAX_ITEMS], unique(cons)[:MAX_ITEMS]

    rules = Explanation(recommendation_id=rec_id, strategy=proposal.strategy, source="RULES", pros=pros,
                        cons=cons, flags=flags, impacts=impacts)
    payload = {
        "now": at(state.now),
        "strategy": STRATEGY_NAMES[proposal.strategy],
        "computed_pros": pros,
        "computed_cons": unique(
            [flag.short for flag in flags if flag.severity != "INFO" or flag.code == "CREW_NOTICE"] + cons),
        "active_plan_vs_proposal": [f"Izvedljive naloge: {before.assigned} → {after.assigned}", *comparisons],
        "active_disruptions": disruptions(state.now, incidents),
    }
    return rules, payload


def unique(items: list[str]) -> list[str]:
    return list(dict.fromkeys(items))


def improves(line: str) -> bool | None:
    match = METRIC_CHANGE.search(line)
    if not match:
        return None
    increase = match.group(2) == "+"
    return increase if match.group(1).lower() == "rezerva" else not increase


def delay_exposure(state: PlanningSnapshot, incidents: list[Incident], rows: list[Assignment]) -> list[Flag]:
    active = active_conditions(state.now, incidents)
    jams = [event for event in active if event.type == "TRAFFIC_DELAY" and event.road_id]
    if not jams:
        return []
    roads = road_network()
    effects = roads.effects(active)
    legs = []
    for vehicle_id, route in routes(rows).items():
        position = state.vehicles[vehicle_id].location
        for row in route:
            task = state.tasks[row.task_id]
            facility = state.facilities[task.facility_id].location
            if row.status != "COMPLETED" and row.planned_dropoff > state.now:
                edges = roads.path_edges(task.pickup, facility, effects)
                if row.planned_pickup > state.now:
                    edges |= roads.path_edges(position, task.pickup, effects)
                legs.append((row, edges))
            position = facility
    flags = []
    for jam in jams:
        segment = roads.segment(jam.road_id)
        if segment is None:
            continue
        blocked = roads.segment_edges(segment)
        exposed = [row for row, edges in legs if edges & blocked]
        vehicles = sorted({row.vehicle_id for row in exposed})
        if not vehicles:
            continue
        message = (f"Skozi zastoj ({segment.name}, ×{jam.multiplier:g}) po predlogu vozijo {', '.join(vehicles)} "
                   f"({', '.join(row.task_id for row in exposed)}).")
        if len(vehicles) >= 2:
            message += " Če se zastoj poslabša, so izpostavljena vsa ta vozila hkrati."
        flags.append(Flag(code="SHARED_DELAY_EXPOSURE", severity="MEDIUM" if len(vehicles) >= 2 else "INFO",
                          message=message, short=f"{', '.join(vehicles)} skozi zastoj ({segment.name})",
                          task_ids=[row.task_id for row in exposed], vehicle_ids=vehicles))
    return flags


def disruptions(now: int, incidents: list[Incident]) -> list[str]:
    roads = road_network()
    road_events = {event.id for event in active_conditions(now, incidents)}
    result = []
    for event in incidents:
        if event.occurred_at > now:
            continue
        if event.type in ("ROAD_CLOSURE", "TRAFFIC_DELAY", "WEATHER_DELAY"):
            if event.id not in road_events:
                continue
            segment = roads.segment(event.road_id) if event.road_id else None
            name = segment.name if segment else "območje"
            result.append(f"Zapora: {name}" if event.type == "ROAD_CLOSURE"
                          else f"Zastoj: {name} (×{event.multiplier:g})")
        elif event.type == "VEHICLE_BREAKDOWN":
            result.append(f"Okvara vozila {event.vehicle_id}")
        elif event.type == "VEHICLE_UNAVAILABLE":
            result.append(f"Vozilo {event.vehicle_id} ni na voljo")
        elif event.type == "NEW_TASK":
            result.append(f"Nova naloga {event.task_id}")
        elif event.type == "FACILITY_CAPACITY_CHANGE":
            result.append(f"Nova kvota ustanove {event.facility_id}: {event.quota}")
    return result


class Advisor:
    def __init__(self, url: str | None, model: str, transport: httpx.BaseTransport | None = None):
        self.url = url.rstrip("/") if url else None
        self.model = model
        self.client = httpx.Client(transport=transport, timeout=httpx.Timeout(180, connect=3))
        self.cache: dict[str, Explanation] = {}
        self.lock = Lock()

    @classmethod
    def from_env(cls) -> "Advisor":
        return cls(os.environ.get("RESCUEFLOW_OLLAMA_URL", "http://127.0.0.1:11434"),
                   os.environ.get("RESCUEFLOW_OLLAMA_MODEL", "gemma3"))

    def explain(self, rules: Explanation, payload: dict) -> Explanation:
        if rules.recommendation_id in self.cache:
            return self.cache[rules.recommendation_id]
        if not self.url:
            return rules.model_copy(update={"notice": "Lokalni jezikovni model ni nastavljen."})
        with self.lock:
            if rules.recommendation_id in self.cache:
                return self.cache[rules.recommendation_id]
            try:
                narrative = self._ask(payload)
            except httpx.HTTPStatusError as error:
                reason = (f"model {self.model} ni naložen (ollama pull {self.model})"
                          if error.response.status_code == 404 else f"napaka {error.response.status_code}")
                return rules.model_copy(update={"notice": f"Lokalni model ni odgovoril: {reason}."})
            except httpx.HTTPError:
                return rules.model_copy(update={"notice": f"Ollama ni dosegljiva na {self.url}."})
            except (ValueError, KeyError, TypeError):
                return rules.model_copy(update={"notice": "Odgovor lokalnega modela ni bil v pričakovani obliki."})
            known = set(IDENTIFIER.findall(json.dumps(payload, ensure_ascii=False)))

            def usable(items: list[str]) -> tuple[list[str], bool]:
                lines = [item.strip().rstrip(".") for item in items if item.strip()][:MAX_ITEMS]
                kept = [line for line in lines
                        if set(IDENTIFIER.findall(line)) <= known and len(line.split()) <= MAX_WORDS]
                return kept, len(kept) < len(lines)

            pros, dropped_pros = usable(narrative.pros)
            cons, dropped_cons = usable(narrative.cons)
            pros, cons = ([line for line in pros if improves(line) is not False]
                          + [line for line in cons if improves(line) is True],
                          [line for line in cons if improves(line) is not True]
                          + [line for line in pros if improves(line) is False])
            if not pros and not cons:
                return rules.model_copy(update={"notice": "Odgovor lokalnega modela ni bil uporaben."})
            cons = cons or rules.cons
            missing = [flag.short for flag in rules.flags if flag.severity == "HIGH"
                       and not set(flag.task_ids) & set(IDENTIFIER.findall(" ".join(cons)))]
            result = rules.model_copy(update={
                "source": "OLLAMA", "model": self.model, "pros": pros or rules.pros,
                "cons": unique(missing + cons)[:MAX_ITEMS + len(missing)],
                "notice": "Del odgovora modela je bil izpuščen (predolg ali z neznanimi oznakami)."
                if dropped_pros or dropped_cons else None,
            })
            self.cache[rules.recommendation_id] = result
            return result

    def _ask(self, payload: dict) -> Narrative:
        response = self.client.post(f"{self.url}/api/chat", json={
            "model": self.model,
            "stream": False,
            "format": NARRATIVE_SCHEMA,
            "options": {"temperature": 0.1},
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False, indent=1)},
            ],
        })
        response.raise_for_status()
        return Narrative.model_validate_json(response.json()["message"]["content"])
