import type { Assignment, DispatchPlan, DispatchState, PlanDiff, TransportTask } from './index';

export const VEHICLE_COLORS: Record<string, string> = { V1: '#0f8b7b', V2: '#5984c5', V3: '#dc922c', V4: '#8670c7', V5: '#439bab' };
export const colorFor = (id: string) => VEHICLE_COLORS[id] ?? '#64818a';
export const formatTime = (value: string) => new Intl.DateTimeFormat('sl-SI', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Ljubljana' }).format(new Date(value));
export const equipmentLabel = (value: string) => ({ STRETCHER: 'Nosila', WHEELCHAIR: 'Voziček', OXYGEN: 'Kisik' }[value] ?? value);
export const statusLabel = (value: string) => ({ AVAILABLE: 'Na voljo', EN_ROUTE: 'Na poti', TRANSPORTING: 'V prevozu', UNAVAILABLE: 'Nedosegljivo', BROKEN: 'Okvara' }[value] ?? value);
export const incidentStatus = (value: string) => ({ OPEN: 'Odprt', AWAITING_DECISION: 'Čaka na odločitev', RESOLVED: 'Rešen' }[value] ?? value);
export const incidentType = (value: string) => ({ NEW_TASK: 'Prednostna naloga', VEHICLE_BREAKDOWN: 'Okvara vozila', TRAFFIC_DELAY: 'Prometni zastoj', ROAD_CLOSURE: 'Zapora ceste', VEHICLE_UNAVAILABLE: 'Nedosegljivost' }[value] ?? value);

export function comparePlans(base: DispatchPlan | null, candidate: DispatchPlan | null): PlanDiff {
  const diff: PlanDiff = { added: new Set(), changed: new Set(), removed: new Set(), vehicle_ids: new Set() };
  if (!base || !candidate) return diff;
  const previous = new Map(base.assignments.map(a => [a.task_id, a]));
  const next = new Map(candidate.assignments.map(a => [a.task_id, a]));
  for (const [id, item] of next) {
    const old = previous.get(id);
    if (!old) { diff.added.add(id); diff.vehicle_ids.add(item.vehicle_id); }
    else if (old.vehicle_id !== item.vehicle_id || old.planned_pickup !== item.planned_pickup || old.planned_end !== item.planned_end || old.planned_dropoff !== item.planned_dropoff || old.planned_departure !== item.planned_departure || old.sequence_order !== item.sequence_order) {
      diff.changed.add(id); diff.vehicle_ids.add(old.vehicle_id); diff.vehicle_ids.add(item.vehicle_id);
    }
  }
  for (const [id, item] of previous) if (!next.has(id)) { diff.removed.add(id); diff.vehicle_ids.add(item.vehicle_id); }
  return diff;
}

export function calculatePlanMetrics(plan: DispatchPlan | null, tasks: TransportTask[], now: string) {
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  let delay = 0, atRisk = 0;
  for (const assignment of plan?.assignments ?? []) {
    const task = taskMap.get(assignment.task_id);
    if (!task || new Date(assignment.planned_end) <= new Date(now)) continue;
    const minutes = Math.max(0, Math.ceil((Date.parse(assignment.planned_dropoff) - Date.parse(task.preferred_arrival)) / 60_000));
    delay += minutes;
    if (minutes > 0) atRisk++;
  }
  const assigned = new Set(plan?.assignments.map(a => a.task_id));
  const unassigned = tasks.filter(t => t.status !== 'CANCELLED' && t.status !== 'COMPLETED' && !assigned.has(t.id)).length;
  return { delay, atRisk, unassigned, total: tasks.filter(t => t.status !== 'CANCELLED').length };
}

export function currentAssignment(state: DispatchState, plan: DispatchPlan | null, vehicleId: string): Assignment | undefined {
  return plan?.assignments.find(a => a.vehicle_id === vehicleId && Date.parse(a.planned_departure) <= Date.parse(state.simulated_time) && Date.parse(a.planned_end) > Date.parse(state.simulated_time));
}

export function candidateProblem(base: DispatchPlan | null, candidate: DispatchPlan, tasks: TransportTask[]): string | null {
  // Presentation guard, not a substitute for the backend's complete constraint validator.
  const ids = new Set<string>();
  for (const item of candidate.assignments) {
    if (ids.has(item.task_id)) return 'Predlog vsebuje podvojeno dodelitev naloge.';
    ids.add(item.task_id);
    const task = tasks.find(t => t.id === item.task_id);
    const times = [item.planned_departure, item.planned_pickup, item.planned_dropoff, item.planned_end].map(Date.parse);
    if (times.some(t => !Number.isFinite(t)) || times.some((t, i) => i > 0 && t < times[i - 1])) return 'Predlog vsebuje neveljavne čase.';
    if (!task || times[2] > Date.parse(task.latest_arrival) || times[1] < Date.parse(task.earliest_pickup)) return 'Predlog krši časovno okno naloge.';
  }
  for (const vehicleId of new Set(candidate.assignments.map(a => a.vehicle_id))) {
    const row = candidate.assignments.filter(a => a.vehicle_id === vehicleId).sort((a, b) => Date.parse(a.planned_departure) - Date.parse(b.planned_departure));
    if (row.some((a, i) => i > 0 && Date.parse(a.planned_departure) < Date.parse(row[i - 1].planned_end))) return 'Predlog vsebuje prekrivajoči se dodelitvi.';
  }
  for (const locked of base?.assignments.filter(a => a.is_locked || a.status === 'COMPLETED' || a.status === 'IN_PROGRESS') ?? []) {
    const next = candidate.assignments.find(a => a.task_id === locked.task_id);
    if (!next || next.vehicle_id !== locked.vehicle_id || next.planned_pickup !== locked.planned_pickup || next.planned_end !== locked.planned_end || next.planned_departure !== locked.planned_departure || next.planned_dropoff !== locked.planned_dropoff || next.sequence_order !== locked.sequence_order) return 'Predlog spreminja zaščiteno dodelitev.';
  }
  return null;
}
