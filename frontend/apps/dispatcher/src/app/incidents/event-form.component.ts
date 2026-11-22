import { Component, ElementRef, EventEmitter, NgZone, Output, ViewChild, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Equipment, IncidentInput, IncidentType, Location, Priority } from '@rescueflow/contracts';
import { PRIORITY_LABELS, ROAD_EVENT_DEFAULTS } from '@rescueflow/contracts';
import { formatTime, incidentType } from '@rescueflow/contracts/plan-utils';
import { DispatchStore } from '../core/dispatch-store';
import { IconComponent } from '../shared/icon.component';
import { ReactViewHost } from '../react-host/react-view-host.component';
import type { DispatchViewProps } from '@rescueflow/react-views/src';

@Component({selector:'app-event-form',standalone:true,imports:[FormsModule,IconComponent,ReactViewHost],template:`
<dialog #dialog class="event-dialog" [class.road-event-dialog]="isRoad()||type==='NEW_TASK'" (close)="onClose()"><form ngNativeValidate (ngSubmit)="submit()">
  <div class="form-dialog-header"><span class="dialog-hero-icon"><app-icon [name]="type==='WEATHER_DELAY'?'oxygen':'alert'" [size]="25"/></span><button type="button" class="dialog-close" aria-label="Zapri obrazec" (click)="close()"><app-icon name="close"/></button><span class="eyebrow">SIMULIRANI DOGODEK</span><h2>{{recoveryVehicle?'Prevzem opreme':scheduledMode?'Nova prevozna naloga':label(type)}}</h2><p>Dogodek zabeleži spremembo razmer. Nov razpored aktivirate šele s potrditvijo predloga.</p></div>
  <div class="form-grid">@if(!scheduledMode&&!recoveryVehicle){<label class="field">Vrsta dogodka<select name="type" [ngModel]="type" (ngModelChange)="changeType($event)"><option value="NEW_TASK">Nova prednostna naloga</option><option value="VEHICLE_BREAKDOWN">Okvara vozila</option><option value="VEHICLE_UNAVAILABLE">Nedosegljivost vozila</option><option value="WEATHER_DELAY">Slabo vreme</option><option value="TRAFFIC_DELAY">Prometni zastoj</option><option value="ROAD_CLOSURE">Zapora ceste</option></select></label>}<label class="field">Prioriteta<select name="priority" [(ngModel)]="priority"><option value="P1">{{priorityLabels.P1}}</option><option value="P2">{{priorityLabels.P2}}</option><option value="P3">{{priorityLabels.P3}}</option></select></label>
  @if(type==='VEHICLE_BREAKDOWN'||type==='VEHICLE_UNAVAILABLE'){<label class="field">Vozilo<select name="vehicle" [(ngModel)]="vehicle" required>@for(v of store.state()?.vehicles;track v.id){<option [value]="v.id">{{v.code}} · {{v.vehicle_type}}</option>}</select></label>}
  @if(type==='VEHICLE_UNAVAILABLE'||type==='WEATHER_DELAY'||type==='TRAFFIC_DELAY'||type==='ROAD_CLOSURE'){<label class="field">Predvideno trajanje (min)<input type="number" name="duration" [(ngModel)]="duration" min="5" max="600" required/></label>}
  @if(type==='WEATHER_DELAY'||type==='TRAFFIC_DELAY'){<label class="field">Faktor časa vožnje<input type="number" name="multiplier" [(ngModel)]="multiplier" min="1" max="5" step="0.1" required/></label>}
  @if(type==='NEW_TASK'){
    <fieldset class="field equipment-checkboxes"><legend>{{recoveryVehicle?'Oprema za prevzem':'Zahtevana oprema'}}</legend>@for(option of availableEquipment();track option.value){<label><input type="checkbox" [name]="'equipment-'+option.value" [ngModel]="equipment.includes(option.value)" (ngModelChange)="toggleEquipment(option.value,$event)"/>{{option.label}}</label>}</fieldset>
    @if(!recoveryVehicle){<label class="field">Število potnikov<input type="number" name="passengers" [(ngModel)]="passengers" min="1" max="8" required/></label>}
    @if(!scheduledMode&&!recoveryVehicle){<label class="field">Najzgodnejši prevzem (neobvezno)<input type="time" name="pickup" [(ngModel)]="pickup" aria-describedby="pickup-time-hint"/><small id="pickup-time-hint">Če je polje prazno, je prevzem mogoč takoj.</small></label> }@else{@if(scheduledMode){<label class="field">Datum in čas prevzema<input type="datetime-local" name="scheduled" [(ngModel)]="scheduled" required/></label>}<label class="field">Ciljna ustanova<select name="facility" [(ngModel)]="facility" required>@for(facility of store.state()?.facilities;track facility.id){<option [value]="facility.id">{{facility.name}}</option>}</select></label>@if(scheduledMode){<p class="field full">Naloge za naslednjih 24 ur od simulirane ure odprejo predloge razporeda. Poznejše naloge se samo shranijo.</p>}}
    @if(!recoveryVehicle){<div class="field full road-event-picker">
      <label for="pickup-address">Lokacija prevzema</label>
      <div class="road-search-row"><input id="pickup-address" name="address" [ngModel]="address" (ngModelChange)="editAddress($event)" placeholder="Npr. Zaloška cesta 2" maxlength="200" (keydown.enter)="$event.preventDefault(); findAddress()"/><button type="button" class="button secondary" (click)="findAddress()" [disabled]="searching()||address.trim().length<2">{{searching()?'Iščem …':'Poišči naslov'}}</button></div>
      @if(addresses().length){<ul class="address-results" aria-label="Najdeni naslovi">@for(result of addresses();track result.name){<li><button type="button" class="button secondary" (click)="selectAddress(result)">{{result.name}}</button></li>}</ul>}
      @if(pickupLocation();as location){<p class="road-target-label" role="status"><app-icon name="pin" [size]="16"/><b>{{location.name}}</b></p>}
      @if(formOpen()&&store.roads()&&roadMapProps();as props){<div class="road-event-map"><react-view-host kind="map" [viewProps]="props"/></div>}
    </div>}@else{<div class="field full form-impact"><app-icon name="pin" [size]="18"/><span><b>{{recoveryVehicle}} · {{pickupLocation()?.name}}</b><br/>Lokacija in oprema sta iz okvare vozila. Izberite opremo, prioriteto in cilj dostave. Prevoz ne vključuje pacienta.</span></div>}
  }
  @if(isRoad()){
    <div class="field full road-event-picker"><label for="incident-street">Ulica ali cesta</label><div class="road-search-row"><input id="incident-street" name="street" [(ngModel)]="roadName" list="incident-streets" placeholder="Npr. Celovška cesta"/><datalist id="incident-streets">@for(street of store.roads()?.streets;track street){<option [value]="street"></option>}</datalist><button type="button" class="button secondary" (click)="findRoad()" [disabled]="!roadName.trim()">Poišči</button><button type="button" class="button secondary" (click)="store.pickingRoad.set(!store.pickingRoad())" [attr.aria-pressed]="store.pickingRoad()">{{store.pickingRoad()?'Prekliči izbor':'Izberi na zemljevidu'}}</button></div>
    @if(store.roadTarget();as road){<p class="road-target-label"><app-icon name="pin" [size]="16"/><b>{{road.name}}</b> · izbrani odsek je označen oranžno</p>}@else{<p>Izberite ulico ali kliknite cestni odsek. Motnja vpliva na dejansko cestno omrežje.</p>}
    @if(roadMapProps();as props){<div class="road-event-map"><react-view-host kind="map" [viewProps]="props"/></div>}
    </div>
  }
  @if(type==='WEATHER_DELAY'){<label class="field">Zemljepisna širina<input type="number" name="lat" [(ngModel)]="lat" min="-90" max="90" step="0.0001" required/></label><label class="field">Zemljepisna dolžina<input type="number" name="lon" [(ngModel)]="lon" min="-180" max="180" step="0.0001" required/></label>}
  <label class="field full">Opis / razlog (neobvezno)<textarea name="description" [(ngModel)]="description" rows="3" maxlength="1000" placeholder="Kaj se je zgodilo in kakšen vpliv pričakujete?"></textarea></label></div>
  @if(type==='WEATHER_DELAY'){<div class="form-impact"><app-icon name="clock" [size]="17"/>Časi vožnje v izbranem območju bodo {{multiplier}}× daljši, naslednjih {{duration}} minut.</div>}
  @if(error||store.error()){<p class="form-error" role="alert">{{error||store.error()}}</p>}
  <div class="dialog-actions"><button type="button" class="button secondary" (click)="close()">Prekliči</button><button type="submit" class="button primary" [disabled]="store.busy()||searching()"><app-icon name="done" [size]="17"/>{{store.busy()?'Zapisujem …':recoveryVehicle?'Poišči predloge':scheduledMode?'Dodaj nalogo':'Dodaj dogodek'}}</button></div>
</form></dialog>`})
export class EventFormComponent {
  readonly priorityLabels = PRIORITY_LABELS;
  readonly store=inject(DispatchStore);@ViewChild('dialog')dialog?:ElementRef<HTMLDialogElement>;@Output()created=new EventEmitter<void>();
  @Output()taskCreated=new EventEmitter<{taskId:string;incidentId:string|null}>();
  scheduledMode=false;scheduled='';facility='';recoveryVehicle='';
  openTask(){
    this.open('NEW_TASK');this.scheduledMode=true;this.priority='P3';this.description='';
    this.facility=this.store.state()?.facilities[0]?.id??'';
    const at=new Date(Date.parse(this.store.state()!.simulated_time)+3600_000);
    this.scheduled=new Date(at.getTime()-at.getTimezoneOffset()*60_000).toISOString().slice(0,16);
  }
  openEquipment(vehicleId:string){
    const state=this.store.state(),vehicle=state?.vehicles.find(v=>v.id===vehicleId);
    if(!state||!vehicle||vehicle.status!=='BROKEN')return;
    this.open('NEW_TASK',vehicleId);this.recoveryVehicle=vehicleId;this.priority='P2';
    const breakdown=[...state.incidents].reverse().find(event=>event.incident_type==='VEHICLE_BREAKDOWN'&&event.affected_vehicle_ids.includes(vehicleId));
    this.selectAddress(breakdown?.location??{lat:vehicle.current_lat,lon:vehicle.current_lon,name:vehicle.location_name});
    this.equipment=[...vehicle.equipment];this.facility=state.facilities[0]?.id??'';
    this.description='';
  }
  availableEquipment(){return this.recoveryVehicle?this.equipmentOptions.filter(option=>this.store.state()?.vehicles.find(v=>v.id===this.recoveryVehicle)?.equipment.includes(option.value)):this.equipmentOptions;}
  private readonly zone=inject(NgZone);
  private readonly eventType=signal<IncidentType>('NEW_TASK');
  readonly formOpen=signal(false);
  get type(){return this.eventType();}
  priority:Priority='P1';vehicle='V3';duration=90;multiplier=1.6;equipment:Equipment[]=['OXYGEN'];passengers=1;
  readonly equipmentOptions:{value:Equipment;label:string}[]=[{value:'OXYGEN',label:'Kisik'},{value:'STRETCHER',label:'Nosila'},{value:'WHEELCHAIR',label:'Voziček'}];
  toggleEquipment(value:Equipment,selected:boolean){this.equipment=selected?[...new Set([...this.equipment,value])]:this.equipment.filter(item=>item!==value);}
  lat=46.068;lon=14.542;pickup='';description='';error='';label=incidentType;
  address='';readonly pickupLocation=signal<Location|null>(null);readonly addresses=signal<Location[]>([]);readonly searching=signal(false);
  private searchId=0;
  roadName='';isRoad(){return this.type==='TRAFFIC_DELAY'||this.type==='ROAD_CLOSURE';}
  changeType(type:IncidentType){this.eventType.set(type);this.error='';this.store.pickingRoad.set(false);this.multiplier=type==='TRAFFIC_DELAY'?ROAD_EVENT_DEFAULTS.delay_multiplier:1.6;}
  readonly roadMapProps=computed<DispatchViewProps|null>(()=>{
    const state=this.store.state();if(!state)return null;
    const pickingLocation=this.type==='NEW_TASK';
    return {state,plan:this.store.activePlan(),basePlan:this.store.activePlan(),diff:this.store.diff(),selectedVehicleId:null,isPreview:false,
      tracking:pickingLocation?null:this.store.tracking(),roads:this.store.roads(),roadPreview:pickingLocation?null:this.store.roadTarget(),
      pickingRoad:!pickingLocation&&this.store.pickingRoad(),pickingLocation,locationPreview:pickingLocation?this.pickupLocation():null,
      onPickRoad:point=>pickingLocation?this.zone.run(()=>this.pickLocation(point)):void this.store.pickRoad(point),onSelectVehicle:()=>undefined,onSelectTask:()=>undefined};
  });
  async findRoad(){await this.store.findStreet(this.roadName);}
  private clearAddressSearch(){this.searchId++;this.addresses.set([]);this.searching.set(false);}
  editAddress(address:string){this.address=address;this.clearAddressSearch();this.pickupLocation.set(null);this.error='';}
  async findAddress(){
    const query=this.address.trim();if(query.length<2||this.searching())return;
    this.error='';this.pickupLocation.set(null);this.addresses.set([]);
    const id=++this.searchId;this.searching.set(true);
    try{
      const results=await this.store.gateway.findAddresses?.(query)??[];
      if(id!==this.searchId)return;
      if(results.length===1)this.selectAddress(results[0]);
      else if(results.length)this.addresses.set(results);
      else this.error='Naslova v ljubljanskem izseku ni bilo mogoče najti. Izberite točko na zemljevidu.';
    }catch(error){if(id===this.searchId)this.error=error instanceof Error?error.message:'Iskanje naslova ni uspelo.';}
    finally{if(id===this.searchId)this.searching.set(false);}
  }
  selectAddress(location:Location){this.clearAddressSearch();this.address=location.name;this.pickupLocation.set(location);this.error='';}
  private pickLocation([lat,lon]:[number,number]){
    const bounds=this.store.roads()?.bounds;
    if(bounds&&(lat<bounds[0]||lon<bounds[1]||lat>bounds[2]||lon>bounds[3])){this.error='Izberite lokacijo v prikazanem območju Ljubljane.';return;}
    this.selectAddress({lat,lon,name:'Izbrana točka na zemljevidu'});this.address='';
  }
  open(type:IncidentType='NEW_TASK',vehicle?:string){
    this.scheduledMode=false;this.recoveryVehicle='';
    const state=this.store.state();if(!state)return;
    this.roadName='';this.store.roadTarget.set(null);this.editAddress('');this.pickup='';
    this.equipment=['OXYGEN'];this.passengers=1;
    this.vehicle=vehicle??'V3';this.priority=type==='NEW_TASK'?'P1':'P2';this.store.error.set('');this.duration=ROAD_EVENT_DEFAULTS.duration_minutes;this.changeType(type);
    this.description=type==='WEATHER_DELAY'?'Močno deževje na območju Ljubljane; pričakovani počasnejši prevozi.':type==='NEW_TASK'?'Simulirana nesreča. Dispečer je določil prednostni prevoz.':type==='VEHICLE_BREAKDOWN'?'Tehnična okvara; vozilo ostaja vidno, prihodnje naloge potrebujejo pregled.':'';
    this.formOpen.set(true);this.dialog?.nativeElement.showModal();
  }
  close(){this.dialog?.nativeElement.close();}
  onClose(){this.formOpen.set(false);this.store.pickingRoad.set(false);this.clearAddressSearch();}
  private iso(value:string){const s=this.store.state()!;const [h,m]=value.split(':').map(Number),[sh,sm]=formatTime(s.horizon_start).split(':').map(Number);return new Date(Date.parse(s.horizon_start)+((h-sh)*60+m-sm)*60_000).toISOString();}
  async submit(){
    this.error='';
    if(this.recoveryVehicle){
      if(!this.equipment.length){this.error='Izberite vsaj en kos opreme za prevzem.';return;}
      const result=await this.store.recoverEquipment(this.recoveryVehicle,{priority:this.priority,equipment:[...this.equipment],facility_id:this.facility,description:this.description});
      if(result){this.close();this.taskCreated.emit(result);}return;
    }
    if(this.type==='NEW_TASK'&&!this.pickupLocation()&&this.address.trim().length>=2){
      await this.findAddress();
      if(!this.formOpen()||this.type!=='NEW_TASK')return;
    }
    const input:IncidentInput={incident_type:this.type,priority:this.priority,description:this.description};
    if(this.type!=='NEW_TASK'){
      input.duration_minutes=this.duration;
      input.delay_multiplier=this.multiplier;
    }
    if(this.type==='VEHICLE_BREAKDOWN'||this.type==='VEHICLE_UNAVAILABLE')input.affected_vehicle_id=this.vehicle;
    if(this.type==='WEATHER_DELAY')input.location={lat:Number(this.lat),lon:Number(this.lon),name:'Izbrano območje v Ljubljani'};
    if(this.isRoad()){
      const road=this.store.roadTarget();if(!road){this.error='Najprej izberite ulico ali cestni odsek na zemljevidu.';return;}
      input.road_id=road.id;const point=road.paths[0]?.[0];if(point)input.location={lat:point[0],lon:point[1],name:road.name};
    }
    if(this.type==='NEW_TASK'){
      const location=this.pickupLocation(),state=this.store.state()!;
      if(!location){this.error||=this.addresses().length?'Izberite naslov med rezultati.':'Poiščite naslov ali kliknite lokacijo prevzema na zemljevidu.';return;}
      if(this.scheduledMode){
        const at=new Date(this.scheduled);
        if(!Number.isFinite(at.getTime())||at.getTime()<Date.parse(state.simulated_time)){this.error='Izberite datum in čas v prihodnosti simulirane ure.';return;}
        const result=await this.store.createTask({scheduled_at:at.toISOString(),pickup:{lat:location.lat,lon:location.lon},pickup_name:location.name,
          facility_id:this.facility,priority:this.priority,passenger_count:Number(this.passengers),equipment:[...this.equipment],description:this.description});
        if(result){this.close();this.taskCreated.emit(result);}return;
      }
      const earliest=this.pickup?this.iso(this.pickup):undefined;
      if(earliest&&(Date.parse(earliest)<Date.parse(state.simulated_time)||Date.parse(earliest)>=Date.parse(state.horizon_end))){this.error='Izberite čas prevzema od trenutne simulirane ure do konca dneva.';return;}
      input.task={pickup:location,passenger_count:Number(this.passengers),equipment:[...this.equipment],earliest_pickup:earliest};
    }
    if(await this.store.createIncident(input)){this.close();this.created.emit();const id=this.store.lastCreatedIncidentId();if(!this.isRoad()&&id&&this.store.activePlan())await this.store.generate(id);}
  }
}
