import { PRIORITY_LABELS } from '@rescueflow/contracts';
import { afterNextRender, Component, ElementRef, Injector, OnDestroy, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { IncidentType, Recommendation, RuntimeConfig } from '@rescueflow/contracts';
import type { DispatchViewProps } from '@rescueflow/react-views/src';
import { arrivalAsap, colorFor,equipmentLabel,formatTime,incidentStatus,preferredArrivalLabel,statusLabel,taskAwaitingConfirmation,timelineBounds } from '@rescueflow/contracts/plan-utils';
import { createGateway } from './core/dispatch-api';
import { DispatchStore } from './core/dispatch-store';
import { IconComponent } from './shared/icon.component';
import { ReactViewHost } from './react-host/react-view-host.component';
import { IncidentsPageComponent } from './incidents/incidents-page.component';
import { EventFormComponent } from './incidents/event-form.component';
import { TasksPageComponent } from './tasks/tasks-page.component';
import { VehiclesPageComponent } from './dashboard/vehicles-page.component';
import { OperationsPanelComponent } from './dashboard/operations-panel.component';
import { KpiCardsComponent } from './dashboard/kpi-cards.component';
import { AnalysisPageComponent } from './analysis/analysis-page.component';

type Page='home'|'tasks'|'vehicles'|'incidents'|'analysis';
@Component({selector:'app-root',standalone:true,imports:[FormsModule,IconComponent,ReactViewHost,IncidentsPageComponent,EventFormComponent,TasksPageComponent,VehiclesPageComponent,OperationsPanelComponent,KpiCardsComponent,AnalysisPageComponent],templateUrl:'./app.component.html',styleUrl:'./app.component.css'})
export class AppComponent implements OnInit,OnDestroy {
  readonly priorityLabels = PRIORITY_LABELS;
  readonly arrivalAsap = arrivalAsap;
  readonly preferredArrival = preferredArrivalLabel;
 readonly store=inject(DispatchStore);readonly page=signal<Page>('home');readonly taskId=signal<string|null>(null);readonly confirmation=signal<Recommendation|null>(null);readonly configurationError=signal('');
 @ViewChild('confirmationDialog')dialog?:ElementRef<HTMLDialogElement>;@ViewChild('detailDialog')details?:ElementRef<HTMLDialogElement>;@ViewChild('simulationDialog')simulation?:ElementRef<HTMLDialogElement>;@ViewChild(EventFormComponent)eventForm?:EventFormComponent;
 @ViewChild('incidentDialog')incidentDialog?:ElementRef<HTMLDialogElement>;
 @ViewChild('summaryDialog')summaryDialog?:ElementRef<HTMLDialogElement>;
 openSummary(){this.summaryDialog?.nativeElement.showModal();}
 time=formatTime;color=colorFor;equipment=equipmentLabel;status=statusLabel;eventStatus=incidentStatus;clock='11:20';
 readonly pages:{id:Page;label:string;icon:string}[]=[{id:'home',label:'Domov',icon:'dashboard'},{id:'tasks',label:'Naloge',icon:'list'},{id:'vehicles',label:'Vozila',icon:'ambulance'},{id:'incidents',label:'Dogodki',icon:'bell'},{id:'analysis',label:'Analiza',icon:'activity'}];
 readonly pageTitle=computed(()=>({home:'Operativni pregled',tasks:'Prevozne naloge',vehicles:'Vozila in razpoložljivost',incidents:'Dogodki in odločitve',analysis:'Analiza in napovedi'}[this.page()]));
 readonly date=computed(()=>new Intl.DateTimeFormat('sl-SI',{day:'numeric',month:'long',year:'numeric',timeZone:'Europe/Ljubljana'}).format(new Date(this.store.state()?.simulated_time??'2026-11-21')));
 readonly viewProps=computed<DispatchViewProps|null>(()=>{const state=this.store.state();return state?{state,tracking:this.store.displayedTracking(),roads:this.store.roads(),pickingRoad:this.store.pickingRoad(),roadPreview:this.store.roadTarget(),onPickRoad:location=>void this.store.pickRoad(location),plan:this.store.displayedPlan(),basePlan:this.store.activePlan(),diff:this.store.diff(),selectedVehicleId:this.store.selectedVehicleId(),selectedTaskId:this.store.selectedTaskId(),isPreview:!!this.store.previewPlan(),onSelectVehicle:id=>this.store.selectVehicle(id),onSelectTask:id=>this.inspectTask(id)}:null;});
 readonly timelineRange=computed(()=>{const state=this.store.state();if(!state)return '';const {start,end}=timelineBounds(state);const label=(value:number)=>new Intl.DateTimeFormat('sl-SI',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Ljubljana'}).format(value);return end-start>24*3600_000?label(start)+'–'+label(end):formatTime(new Date(start).toISOString())+'–'+formatTime(new Date(end).toISOString());});
 readonly selectedTask=computed(()=>[...this.store.state()?.tasks??[],...this.store.state()?.future_tasks??[]].find(t=>t.id===this.taskId()));readonly selectedAssignment=computed(()=>this.store.displayedPlan()?.assignments.find(a=>a.task_id===this.taskId()));readonly affectedVehicles=computed(()=>[...this.store.diff().vehicle_ids].join(', ')||'—');
 private readonly hashChange=()=>this.readHash();
 private readonly injector=inject(Injector);
 async ngOnInit(){this.readHash();window.addEventListener('hashchange',this.hashChange);try{const response=await fetch('/config.json',{cache:'no-store'});if(!response.ok)throw new Error('Nastavitev aplikacije ni mogoče naložiti.');const config=await response.json() as RuntimeConfig;if(!['api','demo'].includes(config.dataSource))throw new Error('Vir podatkov ni pravilno nastavljen.');await this.store.init(createGateway(config));}catch(error){this.configurationError.set(error instanceof Error?error.message:'Napaka pri zagonu.');this.store.loading.set(false);}}
 ngOnDestroy(){window.removeEventListener('hashchange',this.hashChange);this.store.dispose();}
 private readHash(){const hash=window.location.hash.slice(1),value=hash==='overview'?'home':hash==='fleet'?'vehicles':hash;this.page.set(this.pages.some(p=>p.id===value)?value as Page:'home');}
 navigate(page:Page){this.page.set(page);window.location.hash=page;}
 inspectIncident(id:string){const incident=this.store.state()?.incidents.find(i=>i.id===id);if(incident&&this.store.isRoadIncident(incident)){this.store.showRoadNotice(incident);return;}this.store.inspectIncident(id);afterNextRender(()=>{const dialog=this.incidentDialog?.nativeElement;if(dialog&&!dialog.open)dialog.showModal();},{injector:this.injector});}
 async regeneratePlan(){
   await this.store.regeneratePlan();
 }
 closeIncidentReview(){this.incidentDialog?.nativeElement.close();this.store.closeIncident();}
 inspectTask(id:string){this.taskId.set(id);this.store.selectTask(id);this.details?.nativeElement.showModal();}
 showTaskTimeline(){
   this.details?.nativeElement.close();this.closeIncidentReview();this.navigate('tasks');
   afterNextRender(()=>{
     const timeline=document.getElementById('transport-timeline');
     timeline?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});
     timeline?.focus({preventScroll:true});
   },{injector:this.injector});
 }
 showConfirmation(rec:Recommendation){this.store.pin(rec.id);this.confirmation.set(rec);this.dialog?.nativeElement.showModal();}
 closeConfirmation(){this.dialog?.nativeElement.close();this.confirmation.set(null);}
 async accept(){const rec=this.confirmation();if(!rec)return;if(await this.store.accept(rec)){this.closeConfirmation();this.closeIncidentReview();}}
 openSimulation(){this.simulation?.nativeElement.showModal();}
 openEvent(type:IncidentType='NEW_TASK',vehicle?:string){this.simulation?.nativeElement.close();this.eventForm?.open(type,vehicle);}
 async taskCreated(result:{taskId:string;incidentId:string|null}){
   this.navigate('tasks');
   if(result.incidentId){this.inspectIncident(result.incidentId);await this.store.generate(result.incidentId);}
 }
 async advanceClock(){const s=this.store.state();if(!s)return;const [h,m]=this.clock.split(':').map(Number),[sh,sm]=formatTime(s.horizon_start).split(':').map(Number);if(!/^\d{2}:\d{2}$/.test(this.clock)||h<0||h>23||m<0||m>59){this.store.error.set('Izberite veljavno uro med 00:00 in 23:59.');return;}const target=new Date(Date.parse(s.horizon_start)+((h-sh)*60+m-sm)*60_000).toISOString();await this.store.advanceTime(target);}
 async reset(){this.details?.nativeElement.close();this.closeIncidentReview();this.closeConfirmation();await this.store.reset();}
 taskPending(id:string){const state=this.store.state();return !!state&&!state.future_tasks?.some(t=>t.id===id)&&taskAwaitingConfirmation(state,id,this.store.displayedPlan());}
 resolvedCount(){return this.store.state()?.incidents.filter(i=>i.status==='RESOLVED').length??0;}
}
