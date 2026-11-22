import type { Assignment, DispatchPlan, DispatchState, PlanDiff, TransportTask } from './index';

export const VEHICLE_COLORS: Record<string, string> = { V1: '#1e5ec1', V2: '#00846e', V3: '#7d42bc', V4: '#a76a05', V5: '#ac397d' };
export const colorFor = (id: string) => VEHICLE_COLORS[id] ?? '#64818a';
export const formatTime = (value: string | null) => value===null?'—':new Intl.DateTimeFormat('sl-SI', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Ljubljana' }).format(new Date(value));
export const equipmentLabel = (value: string) => ({ STRETCHER: 'Nosila', WHEELCHAIR: 'Voziček', OXYGEN: 'Kisik' }[value] ?? value);
export const statusLabel = (value: string) => ({ AVAILABLE: 'Na voljo', EN_ROUTE: 'Na poti', TRANSPORTING: 'V prevozu', SERVICE:'Predaja / čiščenje', UNAVAILABLE: 'Nedosegljivo', BROKEN: 'Okvara' }[value] ?? value);
export const incidentStatus = (value: string) => ({ OPEN: 'Novo', AWAITING_DECISION: 'Čaka na odločitev', RESOLVED: 'Rešeno' }[value] ?? value);
export const incidentType = (value: string) => ({ NEW_TASK: 'Prednostna naloga', VEHICLE_BREAKDOWN: 'Okvara vozila', TRAFFIC_DELAY: 'Prometni zastoj', ROAD_CLOSURE: 'Zapora ceste', VEHICLE_UNAVAILABLE: 'Nedosegljivost',WEATHER_DELAY:'Slabo vreme',FACILITY_CAPACITY_CHANGE:'Sprememba kapacitete' }[value] ?? value);

export function comparePlans(base: DispatchPlan | null, candidate: DispatchPlan | null): PlanDiff {
  const diff: PlanDiff = { added: new Set(), changed: new Set(), removed: new Set(), vehicle_ids: new Set() };
  if (!base || !candidate) return diff;
  const previous = new Map(base.assignments.map(a => [a.task_id, a]));
  const next = new Map(candidate.assignments.map(a => [a.task_id, a]));
  for (const [id, item] of next) {
    const old = previous.get(id);
    if (!old) { diff.added.add(id); diff.vehicle_ids.add(item.vehicle_id); }
    else if (old.vehicle_id !== item.vehicle_id || old.planned_pickup !== item.planned_pickup || old.planned_end !== item.planned_end || old.planned_dropoff !== item.planned_dropoff || old.planned_departure !== item.planned_departure) {
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
  return { delay:plan?.metrics?.delay_minutes ?? delay, atRisk:plan?.metrics?.at_risk_tasks ?? atRisk, unassigned, total: tasks.filter(t => t.status !== 'CANCELLED').length };
}

export function currentAssignment(state: DispatchState, plan: DispatchPlan | null, vehicleId: string): Assignment | undefined {
  return plan?.assignments.find(a=>a.vehicle_id===vehicleId&&a.status==='IN_PROGRESS') ?? plan?.assignments.find(a => a.vehicle_id === vehicleId && a.status!=='COMPLETED' && Date.parse(a.planned_departure) <= Date.parse(state.simulated_time) && Date.parse(a.planned_end) > Date.parse(state.simulated_time));
}

export function passengerOnBoard(state:DispatchState,vehicleId:string):boolean {
  const vehicle=state.vehicles.find(v=>v.id===vehicleId);
  if(!vehicle)return false;
  const assignment=currentAssignment(state,state.active_plan,vehicleId);
  const task=state.tasks.find(t=>t.id===assignment?.task_id);
  return !!task && task.actual_arrival==null && (task.actual_pickup!=null || task.status==='PICKED_UP');
}

export function timelineStatus(state:DispatchState,assignment:Assignment):'active'|'future'|'completed'|'failed' {
  if(assignment.status==='COMPLETED')return 'completed';
  const task=state.tasks.find(t=>t.id===assignment.task_id);
  const vehicle=state.vehicles.find(v=>v.id===assignment.vehicle_id);
  const blocked=state.issues?.some(i=>i.task_id===assignment.task_id&&[
    'MANUAL_COORDINATION','LOCKED_EXECUTION_BLOCKED','VEHICLE_UNAVAILABLE',
    'NO_COMPATIBLE_VEHICLE','UNREACHABLE_ROUTE','INVALID_TRAVEL_TIME','HARD_TIME_WINDOW',
  ].includes(i.code));
  if(assignment.status==='FAILED'||task?.status==='FAILED'||vehicle?.status==='BROKEN'||blocked)return 'failed';
  return assignment.status==='IN_PROGRESS'?'active':'future';
}

export function vehicleEta(state:DispatchState,vehicleId:string) {
  const vehicle=state.vehicles.find(v=>v.id===vehicleId);
  const empty={pickup:'—',hospital:'—',destination:'Trenutno ni aktivne poti.',task_id:null as string|null};
  if(vehicle?.status==='BROKEN')return {...empty,pickup:'Pot prekinjena',hospital:'Pot prekinjena',destination:'Okvara — potreben je pregled razporeda.'};
  if(vehicle?.status==='UNAVAILABLE')return {...empty,pickup:'Nedosegljivo',hospital:'Nedosegljivo'};
  const assignment=state.active_plan?.assignments.find(a=>a.vehicle_id===vehicleId&&a.status==='IN_PROGRESS');
  const task=state.tasks.find(t=>t.id===assignment?.task_id);
  if(!assignment||!task)return empty;
  if(timelineStatus(state,assignment)==='failed')return {...empty,pickup:'Pot blokirana',hospital:'Pot blokirana',destination:'Prevoz zahteva pregled razporeda.',task_id:task.id};
  const remaining=(time:string)=>Math.ceil((Date.parse(time)-Date.parse(state.simulated_time))/60_000);
  const minutes=(value:number)=>value>0?`${value} min`:value===0?'Zdaj':'Načrtovani čas presežen';
  return {task_id:task.id,destination:task.destination.name,
    pickup:task.actual_pickup!=null||task.status==='PICKED_UP'||task.actual_arrival!=null?'Prevzem opravljen':minutes(remaining(assignment.planned_pickup)),
    hospital:task.actual_arrival!=null?'Na cilju':minutes(remaining(assignment.planned_dropoff))};
}

export function taskAwaitingConfirmation(state:DispatchState,taskId:string,displayed:DispatchPlan|null=state.active_plan):boolean {
  const active=state.active_plan?.assignments.find(a=>a.task_id===taskId);
  if(!active)return true;
  if(!displayed||displayed.id===state.active_plan?.id)return false;
  const proposed=displayed.assignments.find(a=>a.task_id===taskId);
  return !proposed||proposed.vehicle_id!==active.vehicle_id||proposed.planned_departure!==active.planned_departure||proposed.planned_pickup!==active.planned_pickup||proposed.planned_dropoff!==active.planned_dropoff||proposed.planned_end!==active.planned_end;
}

export function vehicleServiceStats(state:DispatchState,vehicleId:string){
  const assignments=state.active_plan?.assignments.filter(a=>a.vehicle_id===vehicleId)??[];
  const cleaning=assignments.map(a=>state.tasks.find(t=>t.id===a.task_id)?.cleaning_minutes).filter((value):value is number=>value!=null&&Number.isFinite(value)&&value>=0);
  const future=assignments.filter(a=>a.status==='PLANNED'&&Date.parse(a.planned_departure)>Date.parse(state.simulated_time)).sort((a,b)=>Date.parse(a.planned_departure)-Date.parse(b.planned_departure));
  return {average_cleaning_minutes:cleaning.length?cleaning.reduce((sum,value)=>sum+value,0)/cleaning.length:null,next_departure:future[0]?.planned_departure??null};
}

export function candidateProblem(base: DispatchPlan | null, candidate: DispatchPlan, tasks: TransportTask[]): string | null {
  // Presentation guard, not a substitute for the backend's complete constraint validator.
  if(candidate.blocking_issues?.length)return candidate.blocking_issues.join(' · ');
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
    if (!next || next.vehicle_id !== locked.vehicle_id || next.planned_pickup !== locked.planned_pickup || next.planned_end !== locked.planned_end || next.planned_departure !== locked.planned_departure || next.planned_dropoff !== locked.planned_dropoff) return 'Predlog spreminja zaščiteno dodelitev.';
  }
  return null;
}
