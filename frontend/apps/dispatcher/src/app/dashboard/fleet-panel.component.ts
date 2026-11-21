import { Component, inject } from '@angular/core';
import { DispatchStore } from '../core/dispatch-store';
import { IconComponent } from '../shared/icon.component';
import { colorFor, equipmentLabel, formatTime, statusLabel } from '@rescueflow/contracts/plan-utils';

@Component({selector:'app-fleet-panel',standalone:true,imports:[IconComponent],template:`
  <div class="panel-heading"><div><app-icon name="ambulance"/><h2>Flota</h2><span class="count-badge">{{store.state()?.vehicles?.length}}</span></div><span class="subtle-label">Vsa vozila</span></div>
  <div class="fleet-list">
  @for(vehicle of store.state()?.vehicles; track vehicle.id) {
    <div class="vehicle-card" [class.selected]="store.selectedVehicleId()===vehicle.id" [class.affected]="store.diff().vehicle_ids.has(vehicle.id)">
      <button class="vehicle-select" (click)="store.selectVehicle(vehicle.id)" [attr.aria-expanded]="store.selectedVehicleId()===vehicle.id">
        <span class="vehicle-symbol" [style.--vehicle-color]="color(vehicle.id)"><app-icon [name]="vehicle.equipment.includes('WHEELCHAIR')?'wheelchair':'ambulance'" [size]="20"/></span>
        <span class="vehicle-main"><span class="vehicle-title"><b>{{vehicle.code}}</b><span class="status-badge" [class.available]="vehicle.status==='AVAILABLE'" [class.unavailable]="vehicle.status==='BROKEN'||vehicle.status==='UNAVAILABLE'">{{status(vehicle.status)}}</span></span><span class="vehicle-type">{{vehicle.vehicle_type}}</span></span>
        <app-icon name="chevron" [size]="14"/>
      </button>
      <div class="vehicle-meta"><span><app-icon name="users" [size]="12"/> {{store.currentAssignment(vehicle.id)?'1':'0'}}/{{vehicle.capacity}}</span><span><app-icon name="clock" [size]="12"/> {{vehicle.status==='AVAILABLE'?'Na voljo zdaj':'Prosto '+time(vehicle.available_at)}}</span></div>
      @if(store.selectedVehicleId()===vehicle.id) {
        <div class="vehicle-details"><p><app-icon name="pin" [size]="13"/>{{vehicle.location_name}}</p><div class="equipment-list">@for(eq of vehicle.equipment;track eq){<span>{{equipment(eq)}}</span>}</div><h4>Naslednje naloge</h4>
        @for(assignment of store.upcoming(vehicle.id);track assignment.task_id){<div class="next-task"><b>{{assignment.task_id}}</b><span>{{time(assignment.planned_pickup)}}–{{time(assignment.planned_dropoff)}}</span></div>}
        <p class="shift-end">Konec izmene {{time(vehicle.shift_end)}}</p></div>
      }
    </div>
  }
  </div>
  <div class="fleet-footnote"><app-icon name="radio" [size]="13"/><span>{{store.gateway.isDemo?'Položaji so ilustrativni':'Položaji iz povezanega sistema'}}</span></div>
`})
export class FleetPanelComponent {readonly store=inject(DispatchStore);color=colorFor;status=statusLabel;time=formatTime;equipment=equipmentLabel;}
