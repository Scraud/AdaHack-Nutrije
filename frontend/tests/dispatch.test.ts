import '@angular/compiler';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoDispatchGateway } from '../apps/dispatcher/src/app/core/dispatch-api';
import { DispatchStore } from '../apps/dispatcher/src/app/core/dispatch-store';
import { calculatePlanMetrics, candidateProblem, comparePlans } from '../packages/contracts/plan-utils';

async function scenario() {
  const gateway=new DemoDispatchGateway();
  const store=new DispatchStore();
  await store.init(gateway);await store.simulateIncident();
  return {gateway,store};
}

test('initial UI fixture has five vehicles, twenty tasks and four facilities',async()=>{
  const state=await new DemoDispatchGateway().getState();
  assert.equal(state.vehicles.length,5);assert.equal(state.tasks.length,20);assert.equal(state.facilities.length,4);
  assert.equal(calculatePlanMetrics(state.active_plan,state.tasks,state.simulated_time).unassigned,0);
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
  assert.equal(candidateProblem(state.active_plan,rec.proposed_plan,state.tasks),null);
  const locked=structuredClone(rec.proposed_plan);locked.assignments[0].vehicle_id='V2';assert.ok(candidateProblem(state.active_plan,locked,state.tasks));
  const late=structuredClone(rec.proposed_plan);late.assignments.at(-1)!.planned_dropoff='2026-11-21T20:00:00Z';late.assignments.at(-1)!.planned_end='2026-11-21T20:10:00Z';assert.ok(candidateProblem(state.active_plan,late,state.tasks));
  const overlap=structuredClone(rec.proposed_plan);const a=overlap.assignments.find(a=>a.task_id==='N021')!;const b=overlap.assignments.find(a=>a.task_id==='N003')!;a.planned_departure=b.planned_departure;a.planned_pickup=b.planned_pickup;assert.ok(candidateProblem(state.active_plan,overlap,state.tasks));
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
