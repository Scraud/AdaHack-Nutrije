import { AfterViewInit, Component, ElementRef, Input, OnChanges, OnDestroy, ViewChild, signal } from '@angular/core';
import * as L from 'leaflet';
import { MOCK_AREAS } from './mock-analytics';

const SLOVENIA_BOUNDS:L.LatLngBoundsExpression=[[45.42,13.37],[46.89,16.62]];
type HeatKind='all'|'accidents'|'transports';

@Component({selector:'app-slovenia-map',standalone:true,template:`
 <div class="country-heat-controls"><label>Prikaz<select aria-label="Vrsta obremenitve na zemljevidu" [value]="kind()" (change)="setKind($any($event.target).value)"><option value="all">Nesreče in potrebni prevozi</option><option value="accidents">Nesreče</option><option value="transports">Potrebni prevozi</option></select></label><span><b>{{totalAccidents}}</b> nesreč · <b>{{totalTransports}}</b> prevozov <small>vzorčno</small></span></div>
 <div class="slovenia-map-wrap">
  <div #canvas class="slovenia-map-canvas" aria-label="Zemljevid obremenitve po območjih celotne Slovenije"></div>
  <button class="button secondary country-fit" (click)="fitCountry()">Cela Slovenija</button>
  <span class="country-map-label">SLOVENIJA <b>VZORČNI PODATKI</b></span>
  <div class="country-heat-legend"><span><i class="heat-low"></i>Nižja</span><span><i class="heat-medium"></i>Srednja</span><span><i class="heat-high"></i>Visoka obremenitev</span></div>
  @if(offline()){<span class="country-map-offline" role="status">Podlaga ni dosegljiva. Prikazane so vzorčne lokacije.</span>}
 </div>
 <label class="country-area-select">Podrobnosti območja<select aria-label="Podrobnosti vzorčnega območja" [value]="selectedArea()" (change)="selectArea($any($event.target).value)"><option value="">Izberite območje</option>@for(area of areas;track area.name){<option [value]="area.name">{{area.name}}</option>}</select></label>
 <p class="area-map-note" aria-live="polite">{{selected()||'Barvne lise prikazujejo večja vzorčna območja nesreč in potrebnih prevozov.'}} Podatki in velikosti območij so ilustrativni.</p>
`})
export class SloveniaMapComponent implements AfterViewInit,OnChanges,OnDestroy {
 @Input()factor=1;
 @ViewChild('canvas',{static:true})canvas!:ElementRef<HTMLDivElement>;
 readonly selected=signal('');readonly offline=signal(false);
 readonly kind=signal<HeatKind>('all');readonly selectedArea=signal('');readonly areas=MOCK_AREAS;
 private map?:L.Map;private features?:L.LayerGroup;private observer?:ResizeObserver;private tiles?:L.TileLayer;private renderer?:L.Canvas;
 get totalAccidents(){return MOCK_AREAS.reduce((sum,a)=>sum+a.accidents,0)*this.factor;}
 get totalTransports(){return MOCK_AREAS.reduce((sum,a)=>sum+a.transports,0)*this.factor;}
 ngAfterViewInit(){
  this.map=L.map(this.canvas.nativeElement,{scrollWheelZoom:false,zoomControl:true,minZoom:6,maxZoom:12});
  this.map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  this.map.createPane('nationalHeat').style.zIndex='420';this.renderer=L.canvas({pane:'nationalHeat',padding:.3});
  this.tiles=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).addTo(this.map);
  this.tiles.on('tileerror',()=>this.offline.set(true));this.tiles.on('tileload',()=>this.offline.set(false));
  this.fitCountry();this.features=L.layerGroup().addTo(this.map);this.draw();
  this.observer=new ResizeObserver(()=>{this.map?.invalidateSize({pan:false});this.fitCountry();});this.observer.observe(this.canvas.nativeElement);
 }
 ngOnChanges(){this.selected.set('');this.selectedArea.set('');this.draw();}
 setKind(kind:HeatKind){this.kind.set(kind);this.draw();}
 selectArea(name:string){this.selectedArea.set(name);const area=MOCK_AREAS.find(a=>a.name===name);this.selected.set(area?this.detail(area):'');}
 private detail(area:typeof MOCK_AREAS[number]){return `${area.name}: ${area.accidents*this.factor} nesreč in ${area.transports*this.factor} potrebnih prevozov · vzorčno.`;}
 fitCountry(){this.map?.fitBounds(SLOVENIA_BOUNDS,{padding:[25,35],animate:false});}
 private draw(){
  if(!this.features)return;this.features.clearLayers();
  for(const area of MOCK_AREAS){
   const point:L.LatLngTuple=[area.lat,area.lon];
   const weight=this.kind()==='accidents'?area.accidents*4:this.kind()==='transports'?area.transports:area.count;
   const color=weight>=95?'#df543a':weight>=60?'#ee9a27':'#399e69';
   const radius=area.radiusKm*1000*(this.kind()==='accidents'?.84:1);
   for(const scale of [1,.85,.68,.5,.3])L.circle(point,{renderer:this.renderer,radius:radius*scale,stroke:false,fillColor:color,fillOpacity:.12,interactive:false}).addTo(this.features);
   const detail=this.detail(area);
   const tooltip=document.createElement('span');tooltip.textContent=detail;
   L.circleMarker(point,{renderer:this.renderer,radius:7,color:'#fff',weight:2,fillColor:color,fillOpacity:1})
    .addTo(this.features).bindTooltip(tooltip,{direction:'top'})
    .on('click',()=>this.selectArea(area.name));
  }
 }
 ngOnDestroy(){this.observer?.disconnect();this.tiles?.off();this.map?.remove();}
}
