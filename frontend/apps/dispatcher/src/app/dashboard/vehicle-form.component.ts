import { Component, ElementRef, ViewChild, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Equipment, Vehicle, VehicleTaskType } from '@rescueflow/contracts';
import { equipmentLabel, taskTypeLabel } from '@rescueflow/contracts/plan-utils';
import { DispatchStore } from '../core/dispatch-store';
import { IconComponent } from '../shared/icon.component';

const EQUIPMENT: Equipment[] = ['STRETCHER', 'WHEELCHAIR', 'OXYGEN', 'VENTILATOR'];
const TASK_TYPES: VehicleTaskType[] = ['PLANNED_TRANSPORT', 'PRIORITY_TRANSPORT', 'EQUIPMENT_DELIVERY'];

@Component({selector:'app-vehicle-form',standalone:true,imports:[FormsModule,IconComponent],template:`
<dialog #dialog class="event-dialog vehicle-dialog" (close)="error=''"><form ngNativeValidate (ngSubmit)="submit()">
  <div class="form-dialog-header"><span class="dialog-hero-icon"><app-icon name="ambulance" [size]="25"/></span><button type="button" class="dialog-close" aria-label="Zapri obrazec" (click)="close()"><app-icon name="close"/></button><span class="eyebrow">FLOTA</span><h2>{{editing?'Uredi vozilo '+editing:'Dodaj vozilo'}}</h2><p>{{editing?'Sprememba velja takoj. Naloge, ki jih vozilo ne more več opraviti, prerazporedite s predlogom.':'Novo vozilo začne na izbranem centru in je takoj na voljo za razporejanje.'}}</p></div>
  <div class="form-grid">
    @if(!editing){<label class="field">Izhodišče<select name="base" [(ngModel)]="base" required>@for(f of store.state()?.facilities;track f.id){<option [value]="f.id">{{f.name}}</option>}</select></label>}
    <label class="field">Kapaciteta (potniki)<input type="number" name="capacity" [(ngModel)]="capacity" min="1" max="8" required/></label>
    <fieldset class="field full checkbox-group"><legend>Oprema</legend>
      @for(item of equipmentOptions;track item){<label class="checkbox-option"><input type="checkbox" [name]="'equipment-'+item" [checked]="equipment.has(item)" (change)="toggle(equipment,item)"/>{{equipmentLabel(item)}}</label>}
    </fieldset>
    <fieldset class="field full checkbox-group"><legend>Vrste nalog</legend>
      @for(item of taskTypeOptions;track item){<label class="checkbox-option"><input type="checkbox" [name]="'type-'+item" [checked]="taskTypes.has(item)" (change)="toggle(taskTypes,item)"/>{{taskTypeLabel(item)}}</label>}
    </fieldset>
  </div>
  @if(error||store.error()){<p class="form-error" role="alert">{{error||store.error()}}</p>}
  <div class="dialog-actions"><button type="button" class="button secondary" (click)="close()">Prekliči</button><button type="submit" class="button primary" [disabled]="store.busy()"><app-icon name="done" [size]="17"/>{{store.busy()?'Shranjujem …':editing?'Shrani spremembe':'Dodaj vozilo'}}</button></div>
</form></dialog>`})
export class VehicleFormComponent {
  readonly store = inject(DispatchStore);
  @ViewChild('dialog') dialog?: ElementRef<HTMLDialogElement>;
  readonly equipmentOptions = EQUIPMENT;
  readonly taskTypeOptions = TASK_TYPES;
  readonly equipmentLabel = equipmentLabel;
  readonly taskTypeLabel = taskTypeLabel;
  editing: string | null = null;
  base = '';
  capacity = 2;
  equipment = new Set<Equipment>();
  taskTypes = new Set<VehicleTaskType>(TASK_TYPES);
  error = '';

  open(vehicle?: Vehicle) {
    this.editing = vehicle?.id ?? null;
    this.capacity = vehicle?.capacity ?? 2;
    this.equipment = new Set(vehicle?.equipment ?? ['STRETCHER']);
    this.taskTypes = new Set(vehicle?.task_types ?? TASK_TYPES);
    this.base = this.store.state()?.facilities[0]?.id ?? '';
    this.error = '';
    this.store.error.set('');
    this.dialog?.nativeElement.showModal();
  }

  close() { this.dialog?.nativeElement.close(); }

  toggle<T>(set: Set<T>, item: T) { if (set.has(item)) set.delete(item); else set.add(item); }

  async submit() {
    if (!this.taskTypes.size) { this.error = 'Izberite vsaj eno vrsto nalog.'; return; }
    const settings = { capacity: Number(this.capacity), equipment: EQUIPMENT.filter(item => this.equipment.has(item)),
      task_types: TASK_TYPES.filter(item => this.taskTypes.has(item)) };
    let saved: boolean;
    if (this.editing) saved = await this.store.updateVehicle(this.editing, settings);
    else {
      const facility = this.store.state()?.facilities.find(f => f.id === this.base);
      if (!facility) { this.error = 'Izberite izhodišče vozila.'; return; }
      saved = await this.store.addVehicle({ ...settings, location: { lat: facility.lat, lon: facility.lon } });
    }
    if (saved) this.close();
  }
}
