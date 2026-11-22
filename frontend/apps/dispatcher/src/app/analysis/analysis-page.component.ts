import { Component, computed, signal } from '@angular/core';
import { IconComponent } from '../shared/icon.component';
import { colorFor } from '@rescueflow/contracts/plan-utils';
import { HOURS,MOCK_DEMAND,MOCK_VEHICLES,WEEKDAYS,mockHeat } from './mock-analytics';
import { SloveniaMapComponent } from './slovenia-map.component';

@Component({selector:'app-analysis-page',standalone:true,imports:[IconComponent,SloveniaMapComponent],templateUrl:'./analysis-page.component.html'})
export class AnalysisPageComponent {
 readonly period=signal('week');readonly selectedHour=signal(15);readonly selectedHeat=signal<{day:number;hour:number}|null>(null);
 hours=HOURS;days=WEEKDAYS;vehicles=MOCK_VEHICLES;heatHours=Array.from({length:24},(_,i)=>i);color=colorFor;
 readonly factor=computed(()=>this.period()==='month'?4:this.period()==='year'?48:1);
 readonly periodLabel=computed(()=>this.period()==='month'?'Mesec':this.period()==='year'?'Leto':'Teden');
 readonly demand=computed(()=>MOCK_DEMAND.map(v=>Math.round(v*(this.period()==='month'?1.08:this.period()==='year'?.95:1))));
 readonly peakHour=computed(()=>this.demand().indexOf(Math.max(...this.demand())));
 readonly kpis=computed(()=>[{label:'Opravljeni prevozi',value:String(120*this.factor()),unit:'nalog',note:`Vzorčni obseg · ${this.periodLabel().toLowerCase()}`,icon:'check'},{label:'Povprečen čas prevoza',value:'17',unit:'min 10 s',note:'Od prevzema do dostave · vzorčno',icon:'clock'},{label:'Povprečna zasedenost',value:'71',unit:'%',note:'Delež zasedenega časa · vzorčno',icon:'ambulance'},{label:'Zamujajoči prevozi',value:String(8*this.factor()),unit:'nalog',note:'Po želenem prihodu · vzorčno',icon:'alert'}]);
 heat=mockHeat;
 minutes(value:number){return new Intl.NumberFormat('sl-SI',{maximumFractionDigits:1}).format(value)+' min';}
 heatColor(day:number,hour:number){const value=mockHeat(day,hour);return ['#eff5f1','#dcece1','#b9dac7','#85bd9f','#4c9c7b','#197657'][Math.min(5,Math.floor(value/18))];}
}
