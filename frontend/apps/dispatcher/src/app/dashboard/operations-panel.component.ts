import { PRIORITY_LABELS } from '@rescueflow/contracts';
import { Component, EventEmitter, Input, Output, computed, inject, signal } from '@angular/core';
import type { Recommendation } from '@rescueflow/contracts';
import { calculatePlanMetrics, candidateProblem, comparePlans, formatTime, incidentStatus } from '@rescueflow/contracts/plan-utils';
import { DispatchStore } from '../core/dispatch-store';
import { IconComponent } from '../shared/icon.component';

@Component({selector:'app-operations-panel',standalone:true,imports:[IconComponent],templateUrl:'./operations-panel.component.html'})
export class OperationsPanelComponent {
  readonly priorityLabels = PRIORITY_LABELS;
 @Input()mode:'alerts'|'solutions'='alerts';@Output()inspect=new EventEmitter<string>();
 @Output()editManual=new EventEmitter<void>();
 readonly store=inject(DispatchStore);@Output()confirm=new EventEmitter<Recommendation>();@Output()simulate=new EventEmitter<void>();time=formatTime;status=incidentStatus;readonly sort=signal('priority');readonly showResolved=signal(false);
 readonly alerts=computed(()=>[...new Map((this.store.state()?.incidents??[]).map(i=>[i.id,i])).values()].filter(i=>!this.store.isRoadIncident(i)).filter(i=>this.showResolved()||i.status!=='RESOLVED'||i.id===this.store.selectedIncidentId()).sort((a,b)=>this.sort()==='priority'?a.priority.localeCompare(b.priority)||Date.parse(b.occurred_at)-Date.parse(a.occurred_at):this.sort()==='oldest'?Date.parse(a.occurred_at)-Date.parse(b.occurred_at):Date.parse(b.occurred_at)-Date.parse(a.occurred_at)));
 matches(rec:Recommendation){const id=this.store.selectedIncidentId();return !id||rec.incident_id===id||!!rec.incident_ids?.includes(id);}
 readonly activeRoadIncident=computed(()=>{
   const state=this.store.state()?.backend,id=this.store.selectedIncidentId();
   return state?.incidents.find(i=>String(i.id)===id&&(i.type==='TRAFFIC_DELAY'||i.type==='ROAD_CLOSURE')&&i.ended_at==null&&(i.duration==null||state.now<i.occurred_at+i.duration));
 });
 readonly available=computed(()=>this.store.recommendations().filter(r=>this.matches(r)));
 readonly pinned=computed(()=>this.available().find(r=>r.id===this.store.selectedRecommendationId())??null);
 readonly blocked=computed(()=>this.store.state()?.recommendations.filter(r=>this.matches(r)&&r.status==='PROPOSED'&&r.base_state_revision===this.store.state()?.state_revision&&!!this.problem(r))??[]);
 readonly decisions=computed(()=>this.store.state()?.decisions.filter(d=>this.store.state()?.recommendations.some(r=>r.id===d.recommendation_id&&this.matches(r)))??[]);
 metrics(rec:Recommendation){return calculatePlanMetrics(rec.proposed_plan,this.store.state()!.tasks,this.store.state()!.simulated_time);}
 diff(rec:Recommendation){return comparePlans(this.store.activePlan(),rec.proposed_plan);}
 vehicles(rec:Recommendation){return [...this.diff(rec).vehicle_ids].join(', ')||'Brez spremembe vozil';}
 benefit(rec:Recommendation){const previous=calculatePlanMetrics(this.store.activePlan(),this.store.state()!.tasks,this.store.state()!.simulated_time),next=this.metrics(rec);return next.unassigned<previous.unassigned?`${previous.unassigned-next.unassigned} dodatnih nalog dobi vozilo.`:next.delay<previous.delay?`${previous.delay-next.delay} min manj čakanja na prevzem.`:!this.diff(rec).changed.size?'Obstoječe dodelitve ostanejo nespremenjene.':`${next.total-next.unassigned} nalog je dodeljenih.`;}
 tradeoff(rec:Recommendation){const m=this.metrics(rec),d=this.diff(rec);return `${m.delay} min skupnega čakanja na prevzem · ${d.changed.size} spremenjenih dodelitev${m.unassigned?` · ${m.unassigned} nalog ostane brez vozila`:''}.`;}
 problem(rec:Recommendation){const state=this.store.state();return state?candidateProblem(this.store.activePlan(),rec.proposed_plan,state):null;}
 changedTasks(rec:Recommendation){return [...this.diff(rec).added,...this.diff(rec).changed,...this.diff(rec).removed].slice(0,8);}
 changeText(rec:Recommendation,id:string){const old=this.store.activePlan()?.assignments.find(a=>a.task_id===id),next=rec.proposed_plan.assignments.find(a=>a.task_id===id);return !next?'Odstranjeno iz razporeda':`${old?old.vehicle_id+' → ':''}${next.vehicle_id} · ${formatTime(next.planned_pickup)}`;}
 recTitle(id:string){return this.store.state()?.recommendations.find(r=>r.id===id)?.title??id;}
 manualDelay(id:string){
   const before=this.store.activePlan()?.assignments.find(row=>row.task_id===id);
   const after=this.store.manualPreview()?.assignments.find(row=>row.task_id===id);
   return before&&after?Math.round((Date.parse(after.planned_pickup)-Date.parse(before.planned_pickup))/60_000):0;
 }
}
