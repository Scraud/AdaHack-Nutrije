import { Component, EventEmitter, Output, inject } from '@angular/core';
import type { IncidentType } from '@rescueflow/contracts';
import { colorFor, equipmentLabel, formatTime, passengerOnBoard, statusLabel, vehicleEta, vehicleServiceStats } from '@rescueflow/contracts/plan-utils';
import { DispatchStore } from '../core/dispatch-store';
import { IconComponent } from '../shared/icon.component';
@Component({selector:'app-vehicles-page',standalone:true,imports:[IconComponent],template:`
<section class="panel"><div class="page-panel-header"><div><h2>Operativna flota <span class="count-badge">{{store.state()?.vehicles?.length}}</span></h2><p>Lokacije, oprema in razpoložljivost za naslednji prevoz.</p></div><span class="all-clear"><app-icon name="radio" [size]="15"/>{{store.gateway.isDemo?'Vzorčni položaji':'Položaji iz simulacijskega API'}}</span></div>
<div class="fleet-page-grid">@for(v of store.state()?.vehicles;track v.id){<article class="fleet-large-card vehicle-operational-card" [class.selected]="store.selectedVehicleId()===v.id" [class.is-broken]="v.status==='BROKEN'">
<button class="vehicle-card-heading" (click)="store.selectVehicle(v.id)" [attr.aria-pressed]="store.selectedVehicleId()===v.id"><span class="vehicle-symbol" [style.--vehicle-color]="color(v.id)"><app-icon name="ambulance" [size]="24"/></span><b>{{v.code}}</b><span class="status-badge" [class.available]="v.status==='AVAILABLE'" [class.unavailable]="v.status==='BROKEN'||v.status==='UNAVAILABLE'">{{status(v.status)}}</span></button>
<h3>{{v.vehicle_type}}</h3><p><app-icon name="pin" [size]="15"/>{{v.location_name}}</p><div class="equipment-list">@for(eq of v.equipment;track eq){<span>{{equipment(eq)}}</span>}</div>
<dl class="vehicle-stats"><div><dt>Zasedenost</dt><dd>{{occupancy(v.id)}} / {{v.capacity}}</dd></div><div><dt>Prosto ob</dt><dd>{{time(v.available_at)}}</dd></div><div><dt>Opravljeno</dt><dd>{{completed(v.id)}}</dd></div><div><dt>Preostalo</dt><dd>{{store.upcoming(v.id).length}}</dd></div></dl>
<dl class="vehicle-service-stats"><div><dt>Povpr. čiščenje · plan</dt><dd>{{minutes(serviceStats(v.id).average_cleaning_minutes)}}</dd></div><div><dt>Naslednji odhod</dt><dd>{{v.status==='BROKEN'?'Po odpravi okvare':time(serviceStats(v.id).next_departure)}}</dd></div></dl>
<div class="vehicle-eta"><dl><div><dt>Do prevzema</dt><dd>{{eta(v.id).pickup}}</dd></div><div><dt>Do bolnišnice</dt><dd>{{eta(v.id).hospital}}</dd></div></dl><p>{{eta(v.id).task_id?eta(v.id).task_id+' · ':''}}{{eta(v.id).destination}}</p><small>Preostali čas po aktivnem razporedu</small></div>
@if(store.selectedVehicleId()===v.id){<div class="fleet-upcoming">@for(a of store.upcoming(v.id);track a.task_id){<button (click)="inspect.emit(a.task_id)"><b>{{a.task_id}}</b><span>{{taskName(a.task_id)}}</span><small>{{time(a.planned_pickup)}}</small></button>}@empty{<p>Ni prihodnjih dodelitev.</p>}</div>}
<div class="vehicle-actions">@if(v.status==='BROKEN'){<button class="button primary restore-vehicle" (click)="store.restoreVehicle(v.id)" [disabled]="store.busy()"><app-icon name="check" [size]="17"/>Odpravi okvaro</button>}@else{<button class="text-button" (click)="event.emit({type:'VEHICLE_BREAKDOWN',vehicle:v.id})" [disabled]="store.busy()"><app-icon name="alert" [size]="14"/>Označi okvaro</button><button class="text-button" (click)="event.emit({type:'VEHICLE_UNAVAILABLE',vehicle:v.id})" [disabled]="store.busy()"><app-icon name="clock" [size]="14"/>Nedosegljivost</button>}</div></article>}</div></section>
`})
export class VehiclesPageComponent {
 readonly store=inject(DispatchStore);@Output()event=new EventEmitter<{type:IncidentType;vehicle:string}>();@Output()inspect=new EventEmitter<string>();color=colorFor;equipment=equipmentLabel;time=formatTime;status=statusLabel;
 completed(id:string){return this.store.activePlan()?.assignments.filter(a=>a.vehicle_id===id&&a.status==='COMPLETED').length??0;}
 occupancy(id:string){if(!this.store.state()||!passengerOnBoard(this.store.state()!,id))return 0;const a=this.store.currentAssignment(id);return this.store.state()?.tasks.find(t=>t.id===a?.task_id)?.passenger_count??0;}
 taskName(id:string){return this.store.state()?.tasks.find(t=>t.id===id)?.destination.name??id;}
 eta(id:string){return vehicleEta(this.store.state()!,id);}
 serviceStats(id:string){return vehicleServiceStats(this.store.state()!,id);}
 minutes(value:number|null){return value==null?'—':new Intl.NumberFormat('sl-SI',{maximumFractionDigits:1}).format(value)+' min';}
}
