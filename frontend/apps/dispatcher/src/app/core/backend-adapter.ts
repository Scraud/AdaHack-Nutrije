import type { components } from '@rescueflow/contracts/api';
import type { DispatchPlan, DispatchState, Incident, Recommendation } from '@rescueflow/contracts';
import { incidentType } from '@rescueflow/contracts/plan-utils';
type Schema=components['schemas'];
export type BackendState=Omit<Schema['State'],'incidents'> & {incidents:(Schema['Incident'] & {description?:string;priority?:'P1'|'P2'|'P3';status?:'OPEN'|'RESOLVED';selected_recommendation_id?:string|null})[]};
export type BackendRecommendation=Schema['RecommendationView'] & {incident_ids?:number[]};
const labels:Record<string,string>={MANUAL_COORDINATION:'Začeti prevoz zahteva ročno koordinacijo.',LOCKED_EXECUTION_BLOCKED:'Zaščitena dodelitev je blokirana.',HARD_TIME_WINDOW:'Kršeno obvezno časovno okno.',NO_COMPATIBLE_VEHICLE:'Ni vozila z ustrezno opremo in kapaciteto.',VEHICLE_UNAVAILABLE:'Vozilo ni operativno.',UNREACHABLE_ROUTE:'Pot ni dosegljiva.',INVALID_TRAVEL_TIME:'Motnja je podaljšala vožnjo.',FACILITY_CAPACITY:'Simulirana kvota ustanove je porabljena.',FACILITY_NOT_ACCEPTING:'Ustanova ne sprejema.',NOT_SCHEDULED_WITHIN_BUDGET:'Naloga v časovnem proračunu ni bila razporejena.'};
const strategies={MIN_DELAY:{title:'Najmanj zamud',trade:'Prednost imajo želeni prihodi; možnih je več sprememb razporeda.'},MIN_CHANGES:{title:'Najmanj sprememb',trade:'Ohranja obstoječe dodelitve; lahko pomeni daljše zamude.'},MAX_BUFFER:{title:'Največ časovne rezerve',trade:'Ohranja prostor za naslednje motnje; lahko spremeni več dodelitev.'}};
export const at=(start:string,seconds:number)=>new Date(Date.parse(start)+seconds*1000).toISOString();
const coordinate=(p:Schema['Point'])=>`${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
const issueText=(i:Schema['Issue'])=>`${i.task_id}: ${labels[i.code]??i.code}`;

export function adaptPlan(plan:Schema['PlanView'],state:BackendState):DispatchPlan {
  const order=new Map<string,number>();
  return {id:plan.id,version:plan.version,status:plan.status==='ACTIVE'?'ACTIVE':plan.status==='SUPERSEDED'?'SUPERSEDED':'DRAFT',
    assignments:[...plan.assignments].sort((a,b)=>a.planned_departure-b.planned_departure||a.task_id.localeCompare(b.task_id)).map(a=>{
      const sequence=order.get(a.vehicle_id)??0;order.set(a.vehicle_id,sequence+1);
      return {id:`${plan.id}:${a.task_id}`,task_id:a.task_id,vehicle_id:a.vehicle_id,sequence_order:sequence,planned_departure:at(state.start_at,a.planned_departure),planned_pickup:at(state.start_at,a.planned_pickup),planned_dropoff:at(state.start_at,a.planned_dropoff),planned_end:at(state.start_at,a.planned_end),status:a.status,is_locked:a.is_locked};
    }),unassigned_task_ids:plan.unassigned.map(i=>i.task_id),unassigned_reasons:Object.fromEntries(plan.unassigned.map(i=>[i.task_id,issueText(i)])),blocking_issues:plan.blocking.map(issueText),released_task_ids:plan.released_task_ids,
    metrics:{remaining_buffer_minutes:Math.floor(plan.metrics.min_buffer_seconds/60),delay_minutes:Math.ceil(plan.metrics.delay_seconds/60),at_risk_tasks:plan.metrics.late_tasks,travel_minutes:Math.ceil(plan.metrics.travel_seconds/60),solve_ms:plan.solve_ms}};
}

export function adaptBackendState(raw:BackendState,items:BackendRecommendation[],history:Schema['PlanSummary'][]=[]):DispatchState {
  if(!Array.isArray(raw.vehicles)||!Array.isArray(raw.tasks)||typeof raw.start_at!=='string'||!Number.isFinite(raw.now))throw new Error('Podatki API se ne ujemajo s pogodbo RescueFlow.');
  const active=raw.active_plan?adaptPlan(raw.active_plan,raw):null;
  if(active){
    active.metrics={...active.metrics,delay_minutes:Math.ceil(raw.baseline.metrics.delay_seconds/60),at_risk_tasks:new Set(raw.baseline.affected.map(i=>i.task_id)).size};
    const assigned=new Set(active.assignments.map(a=>a.task_id));
    active.unassigned_task_ids=raw.tasks.filter(t=>!assigned.has(t.id)).map(t=>t.id);
    active.unassigned_reasons={...active.unassigned_reasons,...Object.fromEntries(raw.baseline.affected.filter(i=>active.unassigned_task_ids.includes(i.task_id)).map(i=>[i.task_id,issueText(i)]))};
  }
  const recommendations:Recommendation[]=items.map(rec=>{
    const changes=rec.plan.changes??[],info=strategies[rec.plan.strategy];
    const incidents=(rec.incident_ids??[]).map(String);
    return {id:rec.id,incident_id:incidents.at(-1)??'',incident_ids:incidents,base_plan_id:rec.base_plan_id,base_state_revision:rec.base_revision,
      strategy:rec.plan.strategy,status:['PROPOSED','ACCEPTED','REJECTED','STALE'].includes(rec.status)?rec.status as Recommendation['status']:'STALE',title:info.title,
      explanation:`${rec.plan.assignments.length} dodelitev, ${changes.length} sprememb in ${rec.plan.unassigned.length} nerazporejenih nalog.`,
      trade_off:info.trade,feasibility_reasons:[`Izračun: ${rec.plan.solver_status}.`,rec.plan.coverage_proven?'Pokritost nalog je dokazana.':'Prikazana je najboljša najdena pokritost v časovnem proračunu.',...rec.plan.blocking.map(issueText)],
      proposed_plan:adaptPlan(rec.plan,raw),solver_status:['OPTIMAL','FEASIBLE','INFEASIBLE','UNKNOWN','MODEL_INVALID'].includes(rec.plan.solver_status)?rec.plan.solver_status as Recommendation['solver_status']:'UNKNOWN'};
  });
  const incidents:Incident[]=raw.incidents.map(i=>{
    const task=raw.tasks.find(t=>t.id===i.task_id),vehicle=raw.vehicles.find(v=>v.id===i.vehicle_id),point=i.location??task?.pickup??vehicle?.location;
    const affected=[...new Set([...(i.task_id?[i.task_id]:[]),...raw.baseline.affected.filter(issue=>i.vehicle_id&&issue.vehicle_id===i.vehicle_id).map(issue=>issue.task_id)])];
    return {id:String(i.id),incident_type:i.type,title:incidentType(i.type),priority:task?.priority??i.priority??'P2',
      description:i.description||`${incidentType(i.type)}${i.vehicle_id?` · ${i.vehicle_id}`:''}${i.task_id?` · ${i.task_id}`:''}.`,
      status:i.ended_at!=null||(i.duration!=null&&raw.now>=i.occurred_at+i.duration)||i.status==='RESOLVED'?'RESOLVED':recommendations.some(r=>r.incident_ids?.includes(String(i.id))&&r.status==='PROPOSED'&&r.base_state_revision===raw.revision)?'AWAITING_DECISION':'OPEN',
      occurred_at:at(raw.start_at,i.occurred_at),location:{lat:point?.lat??0,lon:point?.lon??0,name:point?task?.pickup_name??coordinate(point):'Lokacija ni podana'},has_location:!!point,
      affected_vehicle_ids:i.vehicle_id?[i.vehicle_id]:[],affected_task_ids:affected,selected_recommendation_id:i.selected_recommendation_id??undefined,
      duration_minutes:i.duration?i.duration/60:undefined,delay_multiplier:['WEATHER_DELAY','TRAFFIC_DELAY'].includes(i.type)?i.multiplier:undefined};
  });
  return {backend:raw,scenario_id:raw.scenario_id,state_revision:raw.revision,mode:raw.mode,simulated_time:at(raw.start_at,raw.now),horizon_start:raw.start_at,horizon_end:at(raw.start_at,raw.horizon),
    vehicles:raw.vehicles.map(v=>({id:v.id,code:v.id,vehicle_type:v.equipment.includes('STRETCHER')?'Sanitetno vozilo':'Prevoz z vozičkom',status:v.status,current_lat:v.location.lat,current_lon:v.location.lon,location_name:coordinate(v.location),capacity:v.capacity,equipment:v.equipment,available_at:v.next_available===null?null:at(raw.start_at,v.next_available),shift_end:null})),
    facilities:raw.facilities.map(f=>({id:f.id,name:f.name,short_name:f.name,...f.location,accepting:f.accepting})),
    tasks:raw.tasks.map(t=>{
      const facility=raw.facilities.find(f=>f.id===t.facility_id);if(!facility)throw new Error(`Manjka cilj naloge ${t.id}.`);
      const a=raw.active_plan?.assignments.find(a=>a.task_id===t.id);
      return {id:t.id,task_type:t.type,priority:t.priority,status:a?.status==='COMPLETED'?'COMPLETED':a?.status==='IN_PROGRESS'?(t.actual_pickup!=null&&t.actual_arrival==null?'PICKED_UP':'EN_ROUTE_TO_PICKUP'):a?'ASSIGNED':'PENDING',origin:{...t.pickup,name:t.pickup_name??`Prevzem ${t.id} · ${coordinate(t.pickup)}`},destination:{...facility.location,name:facility.name},passenger_count:t.passenger_count,arrival_policy:t.arrival_policy,cleaning_minutes:t.cleaning/60,required_equipment:t.equipment??[],earliest_pickup:at(raw.start_at,t.earliest_pickup),latest_pickup:t.latest_pickup==null?null:at(raw.start_at,t.latest_pickup),preferred_arrival:at(raw.start_at,t.preferred_arrival),latest_arrival:at(raw.start_at,t.latest_arrival),actual_pickup:t.actual_pickup==null?null:at(raw.start_at,t.actual_pickup),actual_arrival:t.actual_arrival==null?null:at(raw.start_at,t.actual_arrival)};
    }),active_plan:active,incidents,recommendations,
    decisions:items.filter(r=>r.decided_at&&(r.status==='ACCEPTED'||r.status==='REJECTED')).map(r=>({id:`decision:${r.id}`,recommendation_id:r.id,action:r.status as 'ACCEPTED'|'REJECTED',reason:r.decision_reason||'Odločitev je zapisana v zaledju.',decided_at:r.decided_at!,actor:'Dispečer'})),
    affected_task_ids:[...new Set(raw.baseline.affected.map(i=>i.task_id))],issues:raw.baseline.affected.map(i=>({...i,message:issueText(i)})),history:history.map(p=>({id:p.id,version:p.version,status:p.status,created_at:p.created_at,strategy:p.strategy}))};
}
