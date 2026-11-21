import { Component, ElementRef, OnDestroy, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import type { Recommendation, RuntimeConfig } from '@rescueflow/contracts';
import type { DispatchViewProps } from '@rescueflow/react-views/src';
import { colorFor, equipmentLabel, formatTime, incidentStatus, statusLabel } from '@rescueflow/contracts/plan-utils';
import { createGateway } from './core/dispatch-api';
import { DispatchStore } from './core/dispatch-store';
import { IconComponent } from './shared/icon.component';
import { FleetPanelComponent } from './dashboard/fleet-panel.component';
import { AssistantPanelComponent } from './recommendations/assistant-panel.component';
import { ReactViewHost } from './react-host/react-view-host.component';
import { IncidentsPageComponent } from './incidents/incidents-page.component';

type Page='overview'|'incidents'|'fleet';
@Component({selector:'app-root',standalone:true,imports:[IconComponent,FleetPanelComponent,AssistantPanelComponent,ReactViewHost,IncidentsPageComponent],templateUrl:'./app.component.html'})
export class AppComponent implements OnInit,OnDestroy {
  readonly store=inject(DispatchStore);
  readonly page=signal<Page>('overview');
  readonly incidentId=signal<string|null>(null);
  readonly taskId=signal<string|null>(null);
  readonly confirmation=signal<Recommendation|null>(null);
  readonly configurationError=signal('');
  @ViewChild('confirmationDialog') dialog?:ElementRef<HTMLDialogElement>;
  @ViewChild('detailDialog') detailDialog?:ElementRef<HTMLDialogElement>;
  time=formatTime;color=colorFor;equipment=equipmentLabel;status=statusLabel;eventStatus=incidentStatus;
  readonly date=computed(()=>new Intl.DateTimeFormat('sl-SI',{day:'numeric',month:'long',year:'numeric',timeZone:'Europe/Ljubljana'}).format(new Date(this.store.state()?.simulated_time ?? '2026-11-21')));
  readonly viewProps=computed<DispatchViewProps|null>(()=>{
    const state=this.store.state();if(!state)return null;
    return {state,plan:this.store.displayedPlan(),basePlan:this.store.activePlan(),diff:this.store.diff(),selectedVehicleId:this.store.selectedVehicleId(),isPreview:!!this.store.previewPlan(),onSelectVehicle:id=>this.store.selectVehicle(id),onSelectTask:id=>this.inspectTask(id)};
  });
  readonly selectedIncident=computed(()=>this.store.state()?.incidents.find(i=>i.id===this.incidentId()));
  readonly incidentDecisions=computed(()=>{
    const recommendations=this.store.state()?.recommendations.filter(r=>r.incident_id===this.incidentId()) ?? [];
    return this.store.state()?.decisions.filter(d=>recommendations.some(r=>r.id===d.recommendation_id)) ?? [];
  });
  readonly selectedTask=computed(()=>this.store.state()?.tasks.find(t=>t.id===this.taskId()));
  readonly selectedAssignment=computed(()=>this.store.displayedPlan()?.assignments.find(a=>a.task_id===this.taskId()));
  readonly affectedVehicles=computed(()=>Array.from(this.store.diff().vehicle_ids).join(', ')||'—');
  private readonly onHashChange=()=>this.readHash();
  async ngOnInit(){
    this.readHash();window.addEventListener('hashchange',this.onHashChange);
    try {
      const response=await fetch('/config.json');
      if(!response.ok)throw new Error('Datoteke config.json ni mogoče prebrati.');
      const config=await response.json() as RuntimeConfig;
      if(!['demo','api'].includes(config.dataSource)||typeof config.apiBaseUrl!=='string')throw new Error('Nastavitev vira podatkov v config.json ni veljavna.');
      await this.store.init(createGateway(config));
    }catch(error){this.configurationError.set(error instanceof Error?error.message:'Napaka pri zagonu.');this.store.loading.set(false);}
  }
  ngOnDestroy(){window.removeEventListener('hashchange',this.onHashChange);}
  private readHash(){const value=window.location.hash.slice(1);this.page.set(value==='incidents'||value==='fleet'?value:'overview');}
  navigate(page:Page){this.page.set(page);window.location.hash=page;}
  showConfirmation(rec:Recommendation){this.store.pin(rec.id);this.confirmation.set(rec);this.dialog?.nativeElement.showModal();}
  closeConfirmation(){this.dialog?.nativeElement.close();this.confirmation.set(null);}
  async accept(){const rec=this.confirmation();if(!rec)return;await this.store.accept(rec);if(!this.store.error())this.closeConfirmation();}
  inspectIncident(id:string){this.taskId.set(null);this.incidentId.set(id);this.detailDialog?.nativeElement.showModal();}
  inspectTask(id:string){this.incidentId.set(null);this.taskId.set(id);this.detailDialog?.nativeElement.showModal();}
  closeDetails(){this.detailDialog?.nativeElement.close();this.incidentId.set(null);this.taskId.set(null);}
  inspectRecommendations(){this.closeDetails();this.navigate('overview');}
  taskName(id:string){return this.store.state()?.tasks.find(t=>t.id===id)?.destination.name ?? id;}
  recTitle(id:string){return this.store.state()?.recommendations.find(r=>r.id===id)?.title ?? id;}
  async reset(){this.closeDetails();this.closeConfirmation();await this.store.reset();}
}
