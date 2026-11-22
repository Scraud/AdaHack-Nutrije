import '@angular/compiler';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoDispatchGateway } from '../apps/dispatcher/src/app/core/dispatch-api';
import { DispatchStore } from '../apps/dispatcher/src/app/core/dispatch-store';
import type { TrackingFrame } from '../packages/contracts';
import { calculatePlanMetrics, candidateProblem, comparePlans, facilityCapacity, trackingEtaLabel, formatTime, latestPickupLabel, MAX_WAIT_MINUTES, windowOverrunMinutes, passengerOnBoard, timelineStatus, timelineBounds, vehicleEta, taskAwaitingConfirmation, vehicleServiceStats } from '../packages/contracts/plan-utils';

async function scenario() {
  const gateway=new DemoDispatchGateway();
  const store=new DispatchStore();
  await store.init(gateway);await store.simulateIncident();
  return {gateway,store};
}

test('facility capacity counts arrivals once, reserves only displayed assignments and updates with previews',()=>{
  const facility={id:'F1',quota:3,accepting:true};
  const tasks=[{id:'T1',facility_id:'F1',actual_arrival:120},{id:'T2',facility_id:'F1',actual_arrival:null},
    {id:'T3',facility_id:'F1',actual_arrival:null},{id:'T4',facility_id:'F2',actual_arrival:120}];
  assert.deepEqual(facilityCapacity(facility,tasks,['T1','T2','T2']),{used:2,arrived:1,reserved:1,capacity:3,free:1,full:false});
  assert.equal(facilityCapacity(facility,tasks,['T1','T2','T3']).full,true);
  assert.equal(facilityCapacity(facility,tasks,['T2','T3']).used,3,'Arrivals keep their slot even when omitted from the displayed route.');
  assert.equal(facilityCapacity(facility,tasks,[]).free,2,'Unassigned tasks must not reserve capacity.');
});

test('zero capacity and reduced quotas stay full without reporting negative free slots',()=>{
  const tasks=[{id:'T1',facility_id:'F1',actual_arrival:0},{id:'T2',facility_id:'F1',actual_arrival:null}];
  const lower=facilityCapacity({id:'F1',quota:1,accepting:true},tasks,['T2']);
  assert.equal(lower.used,2);assert.equal(lower.free,0);assert.equal(lower.full,true);
  assert.equal(facilityCapacity({id:'F1',quota:0,accepting:true},[],[]).full,true);
});

test('opening and resetting prepare a missing plan, while refreshing preserves an existing plan',async()=>{
  const gateway=new DemoDispatchGateway();
  const initial=await gateway.getState();
  let state={...initial,active_plan:null} as typeof initial;
  let generations=0;
  Object.assign(gateway,{
    getState:async()=>structuredClone(state),
    generateInitialPlan:async()=>{generations++;state={...state,active_plan:structuredClone(initial.active_plan)};return structuredClone(state);},
    reset:async()=>{state={...structuredClone(initial),active_plan:null};return structuredClone(state);},
  });
  const store=new DispatchStore();await store.init(gateway);
  assert.ok(store.activePlan());assert.equal(generations,1);
  const id=store.activePlan()!.id;
  await store.refresh();assert.equal(generations,1);assert.equal(store.activePlan()!.id,id);
  await store.reset();assert.equal(generations,2);assert.ok(store.activePlan());
  store.dispose();
});

test('failed automatic planning can be retried without resetting the scenario',async()=>{
  const gateway=new DemoDispatchGateway(),initial=await gateway.getState();
  let fail=true;
  Object.assign(gateway,{
    getState:async()=>({...structuredClone(initial),active_plan:null}),
    generateInitialPlan:async()=>{if(fail)throw new Error('Planning unavailable');return structuredClone(initial);},
  });
  const store=new DispatchStore();await store.init(gateway);
  assert.equal(store.error(),'Planning unavailable');assert.equal(store.busy(),false);
  assert.equal(store.state()!.scenario_id,initial.scenario_id);
  fail=false;await store.refresh();assert.equal(store.error(),'');assert.ok(store.activePlan());
  store.dispose();
});

test('regenerating activates the new plan without changing the clock or adding tasks or events',async()=>{
  const store=new DispatchStore();await store.init(new DemoDispatchGateway());
  const before=structuredClone(store.state()!);
  assert.equal(await store.regeneratePlan(),true);
  assert.notEqual(store.activePlan()!.id,before.active_plan!.id);
  assert.equal(store.state()!.simulated_time,before.simulated_time);
  assert.deepEqual(store.state()!.incidents,before.incidents);
  assert.deepEqual(store.state()!.tasks,before.tasks);
  assert.equal(store.recommendations().length,0);
  assert.equal(store.state()!.decisions.at(-1)!.action,'ACCEPTED');
  store.dispose();
});

test('urgent incident notices survive closing and refresh, then disappear only when resolved',async()=>{
  const {store}=await scenario();const event=store.urgentNotices()[0];
  assert.ok(event);store.inspectIncident(event.id);store.closeIncident();
  assert.equal(store.urgentNotices()[0].id,event.id);
  await store.refresh();assert.equal(store.urgentNotices()[0].id,event.id);
  await store.accept(store.recommendations()[0]);assert.equal(store.urgentNotices().length,0);
  store.dispose();
});

test('road notices can be dismissed without resolving the disruption and never open manual replanning',async()=>{
  const gateway=new DemoDispatchGateway();let state=await gateway.getState();
  Object.assign(gateway,{getState:async()=>structuredClone(state)});
  const store=new DispatchStore();await store.init(gateway);
  const event={id:'road-1',incident_type:'TRAFFIC_DELAY' as const,title:'Zastoj',description:'Celovška cesta',priority:'P2' as const,status:'OPEN' as const,occurred_at:state.simulated_time,location:{lat:46,lon:14,name:'Celovška cesta'},affected_vehicle_ids:[],affected_task_ids:[]};
  state.incidents.push(event);await store.refresh();
  assert.equal(store.roadNotices().length,1);assert.equal(store.urgentNotices().length,0);
  assert.equal(store.alertsVisible(),false,'Road disruptions must not automatically open a manual decision panel.');
  assert.equal(await store.generate(event.id),false);
  store.dismissRoadNotice(store.roadNotices()[0].id);await store.refresh();
  assert.equal(store.roadNotices().length,0);assert.equal(state.incidents[0].status,'OPEN');
  state.incidents.push({...event,id:'road-2'});await store.refresh();
  assert.equal(store.roadNotices().length,1);store.dispose();
});

test('waiting vehicles show their status rather than a countdown until departure',()=>{
  const vehicle={id:'V1',status:'WAITING',location:[46,14],to_pickup:[],to_hospital:[],eta:{destination:'PICKUP',seconds:1800}} as TrackingFrame['vehicles'][number];
  assert.equal(trackingEtaLabel(vehicle),'V čakanju');
  assert.equal(trackingEtaLabel({...vehicle,status:'TO_PICKUP'}),'Do pacienta · 30 min');
  assert.equal(trackingEtaLabel({...vehicle,status:'AT_PICKUP'}),'Prevzem pacienta');
});

test('only manual demo refresh clears road disruptions, while preserving the current plan',async()=>{
  const gateway=new DemoDispatchGateway();let state=await gateway.getState();
  state.incidents=['TRAFFIC_DELAY','ROAD_CLOSURE'].map((type,i)=>({id:`road-${i}`,incident_type:type as 'TRAFFIC_DELAY'|'ROAD_CLOSURE',title:type,description:'Motnja',priority:'P2',status:'OPEN',occurred_at:state.simulated_time,affected_vehicle_ids:[],affected_task_ids:[],location:{lat:46,lon:14,name:'Ulica'}}));
  const resolved:string[]=[];
  Object.assign(gateway,{getState:async()=>structuredClone(state),resolveIncident:async(id:string)=>{
    resolved.push(id);state.incidents=state.incidents.map(event=>event.id===id?{...event,status:'RESOLVED'}:event);return structuredClone(state);
  }});
  const store=new DispatchStore();await store.init(gateway);const plan=store.activePlan()!.id;
  await store.refresh();assert.equal(resolved.length,0);
  await store.refreshDemo();assert.deepEqual(resolved,['road-0','road-1']);
  assert.equal(store.activePlan()!.id,plan);assert.equal(store.roadNotices().length,0);store.dispose();
});

test('timeline expands to include the selected clock outside the operating shift',async()=>{
  const state=await new DemoDispatchGateway().getState();
  const start=Date.parse(state.horizon_start),end=Date.parse(state.horizon_end);
  assert.deepEqual(timelineBounds(state),{start,end});
  state.simulated_time=new Date(start-90*60_000).toISOString();
  assert.deepEqual(timelineBounds(state),{start:start-2*3600_000,end});
  state.simulated_time=new Date(end+90*60_000).toISOString();
  assert.deepEqual(timelineBounds(state),{start,end:end+2*3600_000});
});

test('initial UI fixture has five vehicles, twenty tasks and four facilities',async()=>{
  const state=await new DemoDispatchGateway().getState();
  assert.equal(state.vehicles.length,5);assert.equal(state.tasks.length,20);assert.equal(state.facilities.length,4);
  assert.equal(calculatePlanMetrics(state.active_plan,state.tasks,state.simulated_time).unassigned,0);
});

test('a delayed tracking response cannot overwrite state after a mutation',async()=>{
  const gateway=new DemoDispatchGateway();
  const initial=await gateway.getState();
  const frame:TrackingFrame={scenario_id:initial.scenario_id,revision:initial.state_revision,now:0,mode:'DEMO',playback:{playing:false,speed:60},incidents:[],vehicles:[{id:'V1',location:[46.07,14.51],status:'WAITING',to_pickup:[],to_hospital:[]}]};
  let release!:(frame:TrackingFrame)=>void;
  let pending:Promise<TrackingFrame>|null=null;
  const connected=Object.assign(gateway,{getTracking:async()=>pending??frame});
  const store=new DispatchStore();await store.init(connected);
  pending=new Promise(resolve=>{release=resolve;});
  const oldPoll=store.refreshTracking();
  await store.reset();
  release({...frame,vehicles:[{...frame.vehicles[0],location:[47,15]}]});
  await oldPoll;
  assert.notEqual(store.state()!.vehicles.find(v=>v.id==='V1')!.current_lat,47);
  assert.notEqual(store.tracking()!.vehicles[0].location[0],47);
  store.dispose();
});
test('previewing multiple cards updates the displayed plan without modifying the active plan',async()=>{
  const {gateway,store}=await scenario();
  const original=structuredClone(store.activePlan());
  assert.equal(store.recommendations().length,3);
  for(const rec of store.recommendations()){
    store.hover(rec.id);
    assert.equal(store.displayedPlan()?.id,rec.proposed_plan.id);
    assert.deepEqual(store.activePlan(),original);
    assert.deepEqual((await gateway.getState()).active_plan,original);
  }
  store.hover(null);assert.deepEqual(store.displayedPlan(),original);
});
test('pinned preview survives pointer leave and temporary previews of other cards',async()=>{
  const {store}=await scenario();const [first,second]=store.recommendations();
  store.pin(first.id);store.hover(second.id);assert.equal(store.previewRecommendation()?.id,second.id);
  store.hover(null);assert.equal(store.previewRecommendation()?.id,first.id);
  store.clearPreview();assert.equal(store.previewPlan(),null);
});
test('confirmation activates the selected plan and records the incident decision',async()=>{
  const {store}=await scenario();const rec=store.recommendations()[0];
  store.pin(rec.id);await store.accept(rec);
  assert.equal(store.activePlan()?.id,rec.proposed_plan.id);assert.equal(store.previewPlan(),null);
  assert.equal(store.state()?.incidents[0].status,'RESOLVED');assert.equal(store.state()?.decisions[0].action,'ACCEPTED');
  assert.equal(store.metrics().unassigned,0);assert.equal(store.recommendations().length,0);
});
test('reject leaves the active schedule untouched and removes the candidate',async()=>{
  const {store}=await scenario();const original=structuredClone(store.activePlan());const rec=store.recommendations()[0];
  await store.reject(rec.id);assert.deepEqual(store.activePlan(),original);
  assert.ok(!store.recommendations().some(r=>r.id===rec.id));assert.equal(store.state()?.decisions[0].action,'REJECTED');
});

test('rejecting a proposal retains the remaining route previews and falls back to the active plan only when none remain',async()=>{
  const gateway=new DemoDispatchGateway();
  const connected=Object.assign(gateway,{getTracking:async()=>{
    const state=await gateway.getState();
    return {scenario_id:state.scenario_id,revision:state.state_revision,now:0,mode:'DEMO',playback:{playing:false,speed:60},incidents:[],vehicles:[]} as TrackingFrame;
  }});
  const store=new DispatchStore();await store.init(connected);await store.simulateIncident();
  const [first,second,third]=store.recommendations(),active=structuredClone(store.activePlan());
  store.inspectIncident(store.openIncidents()[0].id);store.pin(first.id);
  assert.ok(store.displayedTracking());
  assert.equal(await store.reject(first.id),true);
  assert.equal(store.previewPlan()!.id,second.proposed_plan.id);assert.ok(store.displayedTracking());
  assert.deepEqual(store.activePlan(),active);
  await store.reject(third.id);
  assert.equal(store.previewPlan()!.id,second.proposed_plan.id);assert.ok(store.displayedTracking());
  await store.reject(second.id);
  assert.equal(store.previewPlan(),null);assert.deepEqual(store.displayedPlan(),active);assert.ok(store.displayedTracking());
  store.dispose();
});
test('stale revisions cannot be previewed or accepted',async()=>{
  const {store,gateway}=await scenario();const rec=store.recommendations()[0];
  store.state.update(s=>s?{...s,state_revision:s.state_revision+1}:s);
  assert.equal(store.recommendations().length,0);
  await gateway.accept(rec.id,(await gateway.getState()));
  await assert.rejects(()=>gateway.accept(rec.id,(store.state()!)),/veljaven/);
});
test('plan differences identify new, moved and removed tasks by task identity',async()=>{
  const {store}=await scenario();const first=store.recommendations()[0];
  const diff=comparePlans(store.activePlan(),first.proposed_plan);
  assert.deepEqual([...diff.added],['N021']);assert.ok(diff.changed.has('N004'));assert.ok(diff.vehicle_ids.has('V1'));assert.ok(diff.vehicle_ids.has('V3'));
  const candidate=structuredClone(first.proposed_plan);candidate.assignments=candidate.assignments.filter(a=>a.task_id!=='N004');
  assert.ok(comparePlans(store.activePlan(),candidate).removed.has('N004'));
});
test('presentation guard blocks overlapping, late and modified locked assignments',async()=>{
  const {store}=await scenario();const state=store.state()!;const rec=store.recommendations()[0];
  assert.equal(candidateProblem(state.active_plan,rec.proposed_plan,state),null);
  const locked=structuredClone(rec.proposed_plan);locked.assignments[0].vehicle_id='V2';assert.ok(candidateProblem(state.active_plan,locked,state));
  const late=structuredClone(rec.proposed_plan);late.assignments.at(-1)!.planned_dropoff='2026-11-21T20:00:00Z';late.assignments.at(-1)!.planned_end='2026-11-21T20:10:00Z';assert.ok(candidateProblem(state.active_plan,late,state));
  const overlap=structuredClone(rec.proposed_plan);const a=overlap.assignments.find(a=>a.task_id==='N021')!;const b=overlap.assignments.find(a=>a.task_id==='N003')!;a.planned_departure=b.planned_departure;a.planned_pickup=b.planned_pickup;assert.ok(candidateProblem(state.active_plan,overlap,state));
});
test('red is ASAP; medium and low get their latest pickup from priority',async()=>{
  const {store}=await scenario();
  const state=store.state()!;
  const high=state.tasks.find(task=>task.id==='N021')!;
  assert.equal(high.latest_pickup,null);
  assert.equal(latestPickupLabel(high),'Čim prej');
  for(const task of state.tasks.filter(task=>task.priority!=='P1')){
    assert.equal((Date.parse(task.latest_pickup!)-Date.parse(task.earliest_pickup))/60_000,MAX_WAIT_MINUTES[task.priority]);
    assert.equal(latestPickupLabel(task),formatTime(task.latest_pickup));
  }
  const candidate=store.recommendations()[0].proposed_plan;
  assert.equal(candidateProblem(state.active_plan,candidate,state),null);
  const tooLate=structuredClone(candidate);
  const lastOfVehicle=(a:typeof tooLate.assignments[number])=>!tooLate.assignments.some(b=>b.vehicle_id===a.vehicle_id&&Date.parse(b.planned_departure)>Date.parse(a.planned_departure));
  const row=tooLate.assignments.find(a=>a.status==='PLANNED'&&lastOfVehicle(a)&&!!state.tasks.find(t=>t.id===a.task_id)?.latest_pickup)!;
  const task=state.tasks.find(t=>t.id===row.task_id)!;
  const shift=Date.parse(task.latest_pickup!)-Date.parse(row.planned_pickup)+60_000;
  for(const key of ['planned_departure','planned_pickup','planned_dropoff','planned_end'] as const)row[key]=new Date(Date.parse(row[key])+shift).toISOString();
  // Windows are soft: a later pickup is shown, not rejected, so no task has to be dropped.
  assert.equal(candidateProblem(state.active_plan,tooLate,state),null);
  assert.equal(windowOverrunMinutes(task,row.planned_pickup),1);
});
test('reset restores the deterministic fixture and clears selection and previews',async()=>{
  const {store}=await scenario();store.pin(store.recommendations()[0].id);store.selectVehicle('V3');await store.reset();
  assert.equal(store.state()?.tasks.length,20);assert.equal(store.state()?.incidents.length,0);
  assert.equal(store.state()?.active_plan?.version,1);assert.equal(store.previewPlan(),null);assert.equal(store.selectedVehicleId(),null);
});
test('fixture reads are copies and cannot mutate gateway state',async()=>{
  const gateway=new DemoDispatchGateway();const state=await gateway.getState();state.vehicles.pop();
  assert.equal((await gateway.getState()).vehicles.length,5);
});

test('a broken vehicle retains its onboard passenger until actual arrival',async()=>{
  const state=await new DemoDispatchGateway().getState();
  const assignment=state.active_plan!.assignments.find(a=>a.status==='IN_PROGRESS')!;
  const vehicle=state.vehicles.find(v=>v.id===assignment.vehicle_id)!;
  const task=state.tasks.find(t=>t.id===assignment.task_id)!;
  vehicle.status='BROKEN';task.actual_pickup=assignment.planned_pickup;task.actual_arrival=null;
  assert.equal(passengerOnBoard(state,vehicle.id),true);
  task.actual_arrival=assignment.planned_dropoff;
  assert.equal(passengerOnBoard(state,vehicle.id),false);
});

test('derived sequence index changes do not move tasks or invalidate locked work',async()=>{
  const state=await new DemoDispatchGateway().getState();
  const candidate=structuredClone(state.active_plan!);
  for(const assignment of candidate.assignments)assignment.sequence_order++;
  assert.equal(candidateProblem(state.active_plan,candidate,state),null);
  assert.equal(comparePlans(state.active_plan,candidate).changed.size,0);
});

test('alerts toggle and incoming events leave solutions closed until explicitly opened',async()=>{
  const store=new DispatchStore();await store.init(new DemoDispatchGateway());
  assert.equal(store.alertsVisible(),false);
  store.toggleAlerts();assert.equal(store.alertsVisible(),true);
  store.toggleAlerts();assert.equal(store.alertsVisible(),false);
  await store.createIncident({incident_type:'NEW_TASK',priority:'P1',description:'Nova motnja'});
  assert.equal(store.alertsVisible(),true);assert.equal(store.selectedIncident(),null);
  const id=store.lastCreatedIncidentId()!;
  await store.generate(id);assert.equal(store.selectedIncident(),null);
  store.toggleIncident(id);assert.equal(store.selectedIncidentId(),id);
  store.pin(store.recommendations()[0].id);
  store.toggleIncident(id);assert.equal(store.selectedIncident(),null);assert.equal(store.previewPlan(),null);
  store.toggleAlerts();assert.equal(store.alertsVisible(),false);
  store.toggleAlerts();assert.equal(store.alertsVisible(),true);
});

test('timeline distinguishes real progress, future work, completion and broken assignments',async()=>{
  const state=await new DemoDispatchGateway().getState();
  const current=state.active_plan!.assignments.find(a=>a.status==='IN_PROGRESS')!;
  const future=state.active_plan!.assignments.find(a=>a.status==='PLANNED')!;
  const completed=state.active_plan!.assignments.find(a=>a.status==='COMPLETED')!;
  assert.equal(timelineStatus(state,current),'active');
  assert.equal(timelineStatus(state,future),'future');
  assert.equal(timelineStatus(state,completed),'completed');
  state.vehicles.find(v=>v.id===current.vehicle_id)!.status='BROKEN';
  assert.equal(timelineStatus(state,current),'failed');
  assert.equal(timelineStatus(state,{...completed,vehicle_id:current.vehicle_id}),'completed');
  assert.equal(timelineStatus(state,{...future,status:'FAILED'}),'failed');
});

test('vehicle ETAs use the active trip, mark pickup completion and never invent travel after failure',async()=>{
  const state=await new DemoDispatchGateway().getState();
  const a=state.active_plan!.assignments.find(a=>a.status==='IN_PROGRESS')!;
  const task=state.tasks.find(t=>t.id===a.task_id)!;
  state.simulated_time=new Date(Date.parse(a.planned_pickup)-5*60_000).toISOString();
  task.status='EN_ROUTE_TO_PICKUP';task.actual_pickup=null;task.actual_arrival=null;
  assert.equal(vehicleEta(state,a.vehicle_id).pickup,'5 min');
  assert.equal(vehicleEta(state,a.vehicle_id).hospital,`${Math.ceil((Date.parse(a.planned_dropoff)-Date.parse(state.simulated_time))/60_000)} min`);
  task.actual_pickup=a.planned_pickup;
  assert.equal(vehicleEta(state,a.vehicle_id).pickup,'Prevzem opravljen');
  task.actual_arrival=a.planned_dropoff;
  assert.equal(vehicleEta(state,a.vehicle_id).hospital,'Na cilju');
  state.issues=[{task_id:task.id,vehicle_id:a.vehicle_id,code:'MANUAL_COORDINATION',message:'Blokada'}];
  assert.equal(vehicleEta(state,a.vehicle_id).hospital,'Pot blokirana');
  state.vehicles.find(v=>v.id===a.vehicle_id)!.status='BROKEN';
  assert.equal(vehicleEta(state,a.vehicle_id).hospital,'Pot prekinjena');
  assert.equal(vehicleEta(state,'unknown').hospital,'—');
});

test('new tasks and changed preview assignments stay unconfirmed until acceptance',async()=>{
  const {store}=await scenario();const state=store.state()!;
  const rec=store.recommendations()[0];
  assert.equal(taskAwaitingConfirmation(state,'N021'),true);
  assert.equal(taskAwaitingConfirmation(state,'N021',rec.proposed_plan),true);
  const changed=comparePlans(state.active_plan,rec.proposed_plan).changed.values().next().value!;
  assert.equal(taskAwaitingConfirmation(state,changed,rec.proposed_plan),true);
  assert.equal(taskAwaitingConfirmation(state,changed),false);
  await store.accept(rec);
  assert.equal(taskAwaitingConfirmation(store.state()!,'N021'),false);
});

test('vehicle service metrics average known cleaning durations and select the next future departure',async()=>{
  const state=await new DemoDispatchGateway().getState(),vehicle=state.vehicles[0];
  const assignments=state.active_plan!.assignments.filter(a=>a.vehicle_id===vehicle.id);
  assignments.forEach((a,i)=>{state.tasks.find(t=>t.id===a.task_id)!.cleaning_minutes=i+1;});
  const stats=vehicleServiceStats(state,vehicle.id);
  assert.equal(stats.average_cleaning_minutes,(assignments.length+1)/2);
  const future=assignments.filter(a=>a.status==='PLANNED'&&a.planned_departure>state.simulated_time).sort((a,b)=>a.planned_departure.localeCompare(b.planned_departure));
  assert.equal(stats.next_departure,future[0]?.planned_departure??null);
  assert.deepEqual(vehicleServiceStats(state,'unknown'),{average_cleaning_minutes:null,next_departure:null});
});
test('the fewest-changes recommendation is always listed last',async()=>{
  const {store}=await scenario();
  assert.deepEqual(store.recommendations().map(r=>r.strategy),['MIN_DELAY','MAX_BUFFER','MIN_CHANGES']);
});
