import '@angular/compiler';
import assert from 'node:assert/strict';
import { HttpDispatchGateway } from '../../apps/dispatcher/src/app/core/dispatch-api';
import { DispatchStore } from '../../apps/dispatcher/src/app/core/dispatch-store';
import { candidateProblem, formatTime } from '../../packages/contracts/plan-utils';

// Run only against an explicitly selected disposable backend: this resets its scenario.
async function main(){
const url=process.env.RESCUEFLOW_TEST_API;
assert.ok(url,'Set RESCUEFLOW_TEST_API to a backend with a disposable test database.');
const gateway=new HttpDispatchGateway(url);
const store=new DispatchStore();
await store.init(gateway);
const healthy=()=>assert.equal(store.error(),'');
await store.reset();healthy();
await store.prepareDemo();healthy();
assert.equal(formatTime(store.state()!.simulated_time),'11:20');
assert.equal(store.state()!.tasks.length,20);
const active=store.activePlan()!.id;
await store.createIncident({incident_type:'NEW_TASK',priority:'P1',description:'Integration: prednostni prevoz'});healthy();
assert.equal(store.selectedIncident(),null,'Incoming events must keep their solutions collapsed.');
const incident=store.state()!.incidents.find(i=>i.id===store.lastCreatedIncidentId())!;
store.toggleIncident(incident.id);
assert.equal(incident.description,'Integration: prednostni prevoz');
assert.equal(store.state()!.tasks.length,21);
assert.equal(store.metrics().unassigned,1);
assert.equal(store.activePlan()!.unassigned_task_ids.length,1);
await store.generate(incident.id);healthy();
assert.ok(store.recommendations().length>0,'Expected a feasible backend proposal.');
assert.ok(store.recommendations().length<=3);
for(const rec of store.recommendations()){
  assert.ok(rec.incident_ids?.includes(incident.id));
  assert.equal(candidateProblem(store.activePlan(),rec.proposed_plan,store.state()!.tasks),null);
  store.hover(rec.id);
  assert.equal(store.displayedPlan()!.id,rec.proposed_plan.id);
  assert.equal((await gateway.getState()).active_plan!.id,active,'Preview must not mutate backend.');
}
store.hover(null);
const selected=store.recommendations()[0];
store.pin(selected.id);await store.accept(selected);healthy();
assert.equal(store.activePlan()!.id,selected.proposed_plan.id);
assert.equal(store.activePlan()!.version,2);
assert.equal(store.selectedIncident()!.status,'RESOLVED');
assert.equal(store.state()!.decisions[0].action,'ACCEPTED');
assert.equal(store.state()!.history!.length,2);
assert.equal(store.metrics().unassigned,0);
console.log('PASS: actual backend planning, preview isolation, acceptance and event history.');

await store.createIncident({incident_type:'WEATHER_DELAY',priority:'P2',description:'Integration: močan dež',duration_minutes:60,delay_multiplier:1.4,location:{lat:46.056,lon:14.505,name:'Ljubljana'}});healthy();
assert.equal(store.selectedIncident(),null);store.toggleIncident(store.lastCreatedIncidentId()!);
assert.equal(store.selectedIncident()!.delay_multiplier,1.4);
assert.equal(store.selectedIncident()!.duration_minutes,60);
assert.equal(store.activePlan()!.version,2);
await store.generate(store.selectedIncidentId()!);healthy();
assert.ok(store.state()!.recommendations.some(r=>r.incident_ids?.includes(store.selectedIncidentId()!)));
console.log('PASS: weather factors and duration reach the real optimizer.');

await store.reset();healthy();await store.prepareDemo();healthy();
await store.createIncident({incident_type:'VEHICLE_BREAKDOWN',affected_vehicle_id:'V3',priority:'P1',description:'Integration: okvara V3'});healthy();
assert.equal(store.selectedIncident(),null);store.toggleIncident(store.lastCreatedIncidentId()!);
assert.equal(store.state()!.vehicles.find(v=>v.id==='V3')!.status,'BROKEN');
assert.ok(store.state()!.vehicles.some(v=>v.id==='V3'));
await store.generate(store.selectedIncidentId()!);healthy();
assert.ok(store.recommendations().length>0);
const before=store.activePlan()!.id;
await store.reject(store.recommendations()[0].id);healthy();
assert.equal(store.activePlan()!.id,before);
assert.ok(store.state()!.decisions.some(d=>d.action==='REJECTED'));
await store.restoreVehicle('V3');healthy();
assert.notEqual(store.state()!.vehicles.find(v=>v.id==='V3')!.status,'BROKEN');
assert.equal(store.activePlan()!.id,before);
assert.ok(store.state()!.incidents.some(i=>i.incident_type==='VEHICLE_BREAKDOWN'&&i.status==='RESOLVED'));
assert.equal(store.recommendations().length,0,'Vehicle repair must invalidate previous candidates.');
await store.createIncident({incident_type:'VEHICLE_UNAVAILABLE',affected_vehicle_id:'V2',priority:'P2',description:'Integration: servis',duration_minutes:35});healthy();
assert.ok(store.state()!.incidents.some(i=>i.incident_type==='VEHICLE_UNAVAILABLE'&&i.duration_minutes===35));
await store.reset();healthy();
assert.equal(store.state()!.incidents.length,0);
assert.equal(store.activePlan(),null);
console.log('PASS: breakdown retained, rejection, unavailability and reset.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
