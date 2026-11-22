import { Component, inject } from '@angular/core';
import { DispatchStore } from '../core/dispatch-store';
import { IconComponent } from '../shared/icon.component';
@Component({selector:'app-kpi-cards',standalone:true,imports:[IconComponent],template:`
<section class="kpi-grid" aria-label="Ključni kazalniki prikazanega razporeda">
<article class="kpi-card"><div class="kpi-label">Aktivna vozila<span class="kpi-icon teal"><app-icon name="ambulance" [size]="18"/></span></div><div class="kpi-value">{{store.activeVehicles()}}<small>/ {{store.state()?.vehicles?.length}}</small></div><span class="kpi-note"><i class="mini-dot"></i>{{store.activeVehicles()===store.state()?.vehicles?.length?'Vsa vozila operativna':'Del flote ni operativen'}}</span></article>
<article class="kpi-card"><div class="kpi-label">Prevozne naloge<span class="kpi-icon blue"><app-icon name="list" [size]="18"/></span></div><div class="kpi-value">{{store.metrics().total}}<small>nalog</small></div><span class="kpi-note">{{store.displayedPlan()?.assignments?.length??0}} dodeljenih v prikazanem planu</span></article>
<article class="kpi-card" [class.kpi-warning]="store.metrics().atRisk>0"><div class="kpi-label">Ogrožene naloge<span class="kpi-icon amber"><app-icon name="alert" [size]="18"/></span></div><div class="kpi-value">{{store.metrics().atRisk}}<small>nalog</small></div><span class="kpi-note">{{store.metrics().atRisk?'Potreben je pregled posledic':'V želenih časovnih okvirih'}}</span></article>
<article class="kpi-card" [class.kpi-warning]="store.metrics().unassigned>0"><div class="kpi-label">Nerazporejene<span class="kpi-icon violet"><app-icon name="layers" [size]="18"/></span></div><div class="kpi-value">{{store.metrics().unassigned}}<small>nalog</small></div><span class="kpi-note">{{store.metrics().unassigned?'Čakajo na dodelitev vozilu':'Vsaka naloga ima svoje vozilo'}}</span></article>
<article class="kpi-card"><div class="kpi-label">Čakanje na prevzem<span class="kpi-icon gray"><app-icon name="clock" [size]="18"/></span></div><div class="kpi-value">{{store.metrics().delay}}<small>min</small></div><span class="kpi-note">{{store.previewPlan()?'V kandidatnem razporedu':'V aktivnem razporedu'}}</span></article>
</section>`})
export class KpiCardsComponent {readonly store=inject(DispatchStore);}
