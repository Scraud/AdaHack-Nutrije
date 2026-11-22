import { Component, ElementRef, EventEmitter, Output, ViewChild, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Equipment, IncidentInput, IncidentType } from '@rescueflow/contracts';
import { ROAD_EVENT_DEFAULTS } from '@rescueflow/contracts';
import { formatTime, incidentType } from '@rescueflow/contracts/plan-utils';
import { DispatchStore } from '../core/dispatch-store';
import { IconComponent } from '../shared/icon.component';
import { ReactViewHost } from '../react-host/react-view-host.component';
import type { DispatchViewProps } from '@rescueflow/react-views/src';

@Component({selector:'app-event-form',standalone:true,imports:[FormsModule,IconComponent,ReactViewHost],template:`
<dialog #dialog class="event-dialog" [class.road-event-dialog]="isRoad()" (close)="store.pickingRoad.set(false)"><form ngNativeValidate (ngSubmit)="submit()">
  <div class="form-dialog-header"><span class="dialog-hero-icon"><app-icon [name]="type==='WEATHER_DELAY'?'oxygen':'alert'" [size]="25"/></span><button type="button" class="dialog-close" aria-label="Zapri obrazec" (click)="close()"><app-icon name="close"/></button><span class="eyebrow">SIMULIRANI DOGODEK</span><h2>{{label(type)}}</h2><p>Dogodek zabeleži spremembo razmer. Nov razpored aktivirate šele s potrditvijo predloga.</p></div>
  <div class="form-grid"><label class="field">Vrsta dogodka<select name="type" [(ngModel)]="type" (ngModelChange)="changeType($event)"><option value="NEW_TASK">Nova prednostna naloga</option><option value="VEHICLE_BREAKDOWN">Okvara vozila</option><option value="VEHICLE_UNAVAILABLE">Nedosegljivost vozila</option><option value="WEATHER_DELAY">Slabo vreme</option><option value="TRAFFIC_DELAY">Prometni zastoj</option><option value="ROAD_CLOSURE">Zapora ceste</option></select></label><label class="field">Prioriteta<select name="priority" [(ngModel)]="priority"><option>P1</option><option>P2</option><option>P3</option></select></label>
  @if(type==='VEHICLE_BREAKDOWN'||type==='VEHICLE_UNAVAILABLE'){<label class="field">Vozilo<select name="vehicle" [(ngModel)]="vehicle" required>@for(v of store.state()?.vehicles;track v.id){<option [value]="v.id">{{v.code}} · {{v.vehicle_type}}</option>}</select></label>}
  @if(type==='VEHICLE_UNAVAILABLE'||type==='WEATHER_DELAY'||type==='TRAFFIC_DELAY'||type==='ROAD_CLOSURE'){<label class="field">Predvideno trajanje (min)<input type="number" name="duration" [(ngModel)]="duration" min="5" max="600" required/></label>}
  @if(type==='WEATHER_DELAY'||type==='TRAFFIC_DELAY'){<label class="field">Faktor časa vožnje<input type="number" name="multiplier" [(ngModel)]="multiplier" min="1" max="5" step="0.1" required/></label>}
  @if(type==='NEW_TASK'){
    <label class="field">Ciljna ustanova<select name="facility" [(ngModel)]="facility" required>@for(f of store.state()?.facilities;track f.id){<option [value]="f.id">{{f.name}}</option>}</select></label><label class="field">Zahtevana oprema<select name="equipment" [(ngModel)]="equipment"><option value="OXYGEN">Kisik</option><option value="STRETCHER">Nosila</option><option value="WHEELCHAIR">Voziček</option></select></label>
    <label class="field">Prevzem<input type="time" name="pickup" [(ngModel)]="pickup" required/></label><label class="field">Želeni prihod<input type="time" name="preferred" [(ngModel)]="preferred" required/></label><label class="field">Najpoznejši prihod<input type="time" name="deadline" [(ngModel)]="deadline" required/></label><label class="field">Število potnikov<input type="number" name="passengers" [(ngModel)]="passengers" min="1" max="8" required/></label>
  }
  @if(isRoad()){
    <div class="field full road-event-picker"><label for="incident-street">Ulica ali cesta</label><div class="road-search-row"><input id="incident-street" name="street" [(ngModel)]="roadName" list="incident-streets" placeholder="Npr. Celovška cesta"/><datalist id="incident-streets">@for(street of store.roads()?.streets;track street){<option [value]="street"></option>}</datalist><button type="button" class="button secondary" (click)="findRoad()" [disabled]="!roadName.trim()">Poišči</button><button type="button" class="button secondary" (click)="store.pickingRoad.set(!store.pickingRoad())" [attr.aria-pressed]="store.pickingRoad()">{{store.pickingRoad()?'Prekliči izbor':'Izberi na zemljevidu'}}</button></div>
    @if(store.roadTarget();as road){<p class="road-target-label"><app-icon name="pin" [size]="16"/><b>{{road.name}}</b> · izbrani odsek je označen oranžno</p>}@else{<p>Izberite ulico ali kliknite cestni odsek. Motnja vpliva na dejansko cestno omrežje.</p>}
    @if(roadMapProps();as props){<div class="road-event-map"><react-view-host kind="map" [viewProps]="props"/></div>}
    </div>
  }
  @if(type==='NEW_TASK'||type==='WEATHER_DELAY'){<label class="field">Zemljepisna širina<input type="number" name="lat" [(ngModel)]="lat" min="-90" max="90" step="0.0001" required/></label><label class="field">Zemljepisna dolžina<input type="number" name="lon" [(ngModel)]="lon" min="-180" max="180" step="0.0001" required/></label>}
  <label class="field full">Opis / razlog (neobvezno)<textarea name="description" [(ngModel)]="description" rows="3" maxlength="1000" placeholder="Kaj se je zgodilo in kakšen vpliv pričakujete?"></textarea></label></div>
  @if(type==='WEATHER_DELAY'){<div class="form-impact"><app-icon name="clock" [size]="17"/>Časi vožnje v izbranem območju bodo {{multiplier}}× daljši, naslednjih {{duration}} minut.</div>}
  @if(type==='NEW_TASK'){<p class="form-note">Prioriteto, zahtevano opremo in cilj prevoza določi dispečer. Sistem jih med razporejanjem ne spreminja.</p>}
  @if(error||store.error()){<p class="form-error" role="alert">{{error||store.error()}}</p>}
  <div class="dialog-actions"><button type="button" class="button secondary" (click)="close()">Prekliči</button><button type="submit" class="button primary" [disabled]="store.busy()"><app-icon name="done" [size]="17"/>{{store.busy()?'Zapisujem …':'Dodaj dogodek'}}</button></div>
</form></dialog>`})
export class EventFormComponent {
  readonly store=inject(DispatchStore);@ViewChild('dialog')dialog?:ElementRef<HTMLDialogElement>;@Output()created=new EventEmitter<void>();
  type:IncidentType='NEW_TASK';priority:'P1'|'P2'|'P3'='P1';vehicle='V3';duration=90;multiplier=1.6;facility='F3';equipment:Equipment='OXYGEN';passengers=1;
  lat=46.068;lon=14.542;pickup='11:35';preferred='12:05';deadline='12:35';description='';error='';label=incidentType;
  roadName='';isRoad(){return this.type==='TRAFFIC_DELAY'||this.type==='ROAD_CLOSURE';}
  changeType(type:IncidentType){this.type=type;this.multiplier=type==='TRAFFIC_DELAY'?ROAD_EVENT_DEFAULTS.delay_multiplier:1.6;}
  readonly roadMapProps=computed<DispatchViewProps|null>(()=>{const state=this.store.state();return state?{state,plan:this.store.activePlan(),basePlan:this.store.activePlan(),diff:this.store.diff(),selectedVehicleId:null,isPreview:false,tracking:this.store.tracking(),roads:this.store.roads(),roadPreview:this.store.roadTarget(),pickingRoad:this.store.pickingRoad(),onPickRoad:location=>void this.store.pickRoad(location),onSelectVehicle:()=>undefined,onSelectTask:()=>undefined}:null;});
  async findRoad(){await this.store.findStreet(this.roadName);}
  open(type:IncidentType='NEW_TASK',vehicle?:string){
    const state=this.store.state();if(!state)return;
    this.roadName='';this.store.roadTarget.set(null);this.store.pickingRoad.set(false);
    this.type=type;this.vehicle=vehicle??'V3';this.priority=type==='NEW_TASK'?'P1':'P2';this.error='';this.store.error.set('');this.duration=ROAD_EVENT_DEFAULTS.duration_minutes;this.changeType(type);
    this.facility=state.facilities.find(f=>f.id==='F3')?.id??state.facilities[0]?.id??'';
    const now=Date.parse(state.simulated_time);this.pickup=formatTime(new Date(now+15*60_000).toISOString());this.preferred=formatTime(new Date(now+45*60_000).toISOString());this.deadline=formatTime(new Date(now+75*60_000).toISOString());
    this.description=type==='WEATHER_DELAY'?'Močno deževje na območju Ljubljane; pričakovani počasnejši prevozi.':type==='NEW_TASK'?'Simulirana prometna nesreča. Dispečer je določil prednostni prevoz.':type==='VEHICLE_BREAKDOWN'?'Tehnična okvara; vozilo ostaja vidno, prihodnje naloge potrebujejo pregled.':'';
    this.dialog?.nativeElement.showModal();
  }
  close(){this.dialog?.nativeElement.close();}
  private iso(value:string){const s=this.store.state()!;const [h,m]=value.split(':').map(Number),[sh,sm]=formatTime(s.horizon_start).split(':').map(Number);return new Date(Date.parse(s.horizon_start)+((h-sh)*60+m-sm)*60_000).toISOString();}
  async submit(){
    this.error='';const input:IncidentInput={incident_type:this.type,priority:this.priority,description:this.description,duration_minutes:this.duration,delay_multiplier:this.multiplier};
    if(this.type==='VEHICLE_BREAKDOWN'||this.type==='VEHICLE_UNAVAILABLE')input.affected_vehicle_id=this.vehicle;
    else input.location={lat:Number(this.lat),lon:Number(this.lon),name:'Izbrano območje v Ljubljani'};
    if(this.isRoad()){
      const road=this.store.roadTarget();if(!road){this.error='Najprej izberite ulico ali cestni odsek na zemljevidu.';return;}
      input.road_id=road.id;const point=road.paths[0]?.[0];if(point)input.location={lat:point[0],lon:point[1],name:road.name};
    }
    if(this.type==='NEW_TASK'){
      const earliest=this.iso(this.pickup),preferred=this.iso(this.preferred),latest=this.iso(this.deadline),state=this.store.state()!;
      if(Date.parse(earliest)<Date.parse(state.simulated_time)||Date.parse(preferred)<Date.parse(earliest)||Date.parse(latest)<Date.parse(preferred)||Date.parse(latest)>Date.parse(state.horizon_end)){this.error='Preverite čase: prevzem od zdaj naprej, želeni prihod pred rokom in rok znotraj dneva.';return;}
      input.task={facility_id:this.facility,pickup:input.location!,passenger_count:Number(this.passengers),equipment:[this.equipment],earliest_pickup:earliest,preferred_arrival:preferred,latest_arrival:latest};
    }
    if(await this.store.createIncident(input)){this.close();this.created.emit();const id=this.store.lastCreatedIncidentId();if(id&&this.store.activePlan())await this.store.generate(id);}
  }
}
