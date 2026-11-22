import { Component, EventEmitter, Output, inject } from '@angular/core';
import type { Recommendation } from '@rescueflow/contracts';
import { calculatePlanMetrics, comparePlans, formatTime } from '@rescueflow/contracts/plan-utils';
import { DispatchStore } from '../core/dispatch-store';
import { IconComponent } from '../shared/icon.component';

@Component({selector:'app-assistant-panel',standalone:true,imports:[IconComponent],template:`
  <div class="panel-heading"><div><app-icon name="sparkles"/><h2>Dispečerski pomočnik</h2></div><span class="assistant-tag">AI</span></div>
  <div class="assistant-body">
  @if(store.openIncidents().length) {
    @for(incident of store.openIncidents();track incident.id){
      <button class="incident-alert" (click)="inspect.emit(incident.id)"><span class="incident-alert-icon"><app-icon name="alert" [size]="18"/></span><span><b>{{incident.title}}</b><small>{{time(incident.occurred_at)}} · {{incident.location.name}}</small></span><span class="priority-badge">{{incident.priority}}</span></button>
    }
    <div class="recommendation-intro"><h3>{{store.gateway.isDemo?'Vzorčne alternative':'Predlogi razporeda'}}<span class="count-badge">{{store.recommendations().length}}</span></h3><p>{{store.gateway.isDemo?'Prikaz UI brez izračuna optimizatorja.':'Premaknite kazalec čez predlog za primerjavo.'}}</p></div>
    @if(store.busy()) {<div class="recommendation-loading" role="status"><app-icon name="loader"/><b>{{store.gateway.isDemo?'Pripravljam prikaz …':'Izračunavam alternative …'}}</b><span></span><span></span><span></span></div>}
    @else {
    <div class="recommendation-list" (mouseleave)="store.hover(null)">
      @for(rec of store.recommendations();track rec.id;let i=$index){
        <button class="recommendation-card" [class.previewed]="store.previewRecommendation()?.id===rec.id" [class.pinned]="store.selectedRecommendationId()===rec.id" (mouseenter)="store.hover(rec.id)" (focus)="store.hover(rec.id)" (blur)="store.hover(null)" (click)="store.pin(rec.id)" [attr.aria-pressed]="store.selectedRecommendationId()===rec.id">
          <span class="recommendation-title"><span class="strategy-icon"><app-icon [name]="i===0?'clock':i===1?'layers':'shield'" [size]="15"/></span><b>{{rec.title}}</b><app-icon [name]="store.selectedRecommendationId()===rec.id?'pinned':'eye'" [size]="14"/></span>
          <span class="recommendation-summary">{{incidentVehicle(rec)}} · {{changed(rec)}} sprememb</span>
          <span class="recommendation-metrics"><span><b>{{metrics(rec).delay}} <small>min</small></b>Zamuda</span><span><b>{{metrics(rec).unassigned}}</b>Nerazporejeno</span><span><b>{{rec.proposed_plan.metrics?.remaining_buffer_minutes ?? '—'}}<small>{{rec.proposed_plan.metrics?.remaining_buffer_minutes !== undefined?' min':''}}</small></b>Rezerva</span></span>
          @if(store.selectedRecommendationId()===rec.id){<span class="rec-explanation">{{rec.explanation}}</span><span class="rec-reason">Vozila s spremembami: {{affected(rec)}}</span>@for(reason of rec.feasibility_reasons;track reason){<span class="rec-reason"><app-icon name="check" [size]="12"/>{{reason}}</span>}<span class="rec-tradeoff">{{rec.trade_off}}</span>}
        </button>
      } @empty {<div class="empty-small"><app-icon name="help"/><b>Ni veljavnih predlogov</b><p>Izvedljive rešitve še niso na voljo. Preverite omejitve in nerazporejene naloge v zaledju.</p><button class="button secondary" (click)="store.generate(store.openIncidents()[0].id)">Ponovi pripravo</button></div>}
    </div>}
  } @else if(store.state()?.incidents?.length) {
    <div class="assistant-empty resolved"><span class="assistant-illustration"><app-icon name="check" [size]="34"/></span><span class="eyebrow">PLAN JE POSODOBLJEN</span><h3>Odločitev je potrjena.</h3><p>Vse spremembe so vidne na zemljevidu in časovnici. Podrobnosti najdete med dogodki.</p><button class="button secondary" (click)="openEvents.emit()">Preglej odločitev<app-icon name="list" [size]="15"/></button></div>
  } @else {
    <div class="assistant-empty"><div class="assistant-art"><span class="art-orbit one"></span><span class="art-orbit two"></span><span class="art-mini left"><app-icon name="route" [size]="17"/></span><span class="assistant-illustration"><app-icon name="sparkles" [size]="32"/></span><span class="art-mini right"><app-icon name="check" [size]="17"/></span></div><span class="eyebrow">MIREN RAZPORED. JASEN PREGLED.</span><h3>Pripravljeni na<br>nepričakovano.</h3><p>Ob motnji primerjajte možnosti in preverite vpliv na celotno floto, preden potrdite spremembo.</p><span class="all-clear"><app-icon name="check" [size]="14"/> Trenutno ni odprtih dogodkov</span></div>
  }
  </div>
  @if(store.previewRecommendation();as rec){<div class="assistant-confirm"><span><app-icon name="eye" [size]="14"/> Predogled {{store.selectedRecommendationId()?'je pripet':'v teku'}}</span><div><button class="button primary" (click)="confirm.emit(rec)" [disabled]="store.busy()"><app-icon name="done" [size]="16"/>Potrdi predlog</button></div></div>}
  @else {<div class="simulation-action"><button class="button primary" (click)="store.simulateIncident()" [disabled]="store.busy()||(store.gateway.isDemo&&!!store.state()?.incidents?.length)"><app-icon name="alert" [size]="16"/>Simuliraj nesrečo</button><small>{{store.gateway.isDemo?'Vzorčni scenarij · nova naloga ob 11:20':'Simulacija · novo nalogo pripravi zaledje'}}</small></div>}
`})
export class AssistantPanelComponent {
  readonly store=inject(DispatchStore);time=formatTime;
  @Output() confirm=new EventEmitter<Recommendation>();
  @Output() inspect=new EventEmitter<string>();
  @Output() openEvents=new EventEmitter<void>();
  metrics(rec:Recommendation){return calculatePlanMetrics(rec.proposed_plan,this.store.state()!.tasks,this.store.state()!.simulated_time);}
  changed(rec:Recommendation){const diff=comparePlans(this.store.activePlan(),rec.proposed_plan);return diff.changed.size+diff.added.size+diff.removed.size;}
  affected(rec:Recommendation){return [...comparePlans(this.store.activePlan(),rec.proposed_plan).vehicle_ids].join(', ')||'—';}
  incidentVehicle(rec:Recommendation){const incident=this.store.state()!.incidents.find(i=>i.id===rec.incident_id);return rec.proposed_plan.assignments.find(a=>incident?.affected_task_ids.includes(a.task_id))?.vehicle_id ?? 'Brez dodelitve';}
}
