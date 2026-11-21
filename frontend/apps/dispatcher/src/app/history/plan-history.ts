import { Component, inject } from '@angular/core';
import { DispatchStore } from '../core/dispatch-store';
import { strategies } from '../core/labels';

@Component({
  selector: 'plan-history',
  template: `
    <section class="card">
      <div class="card-head"><div><h2>Zgodovina planov</h2><p>Aktivirana zaporedja in odločitve</p></div></div>
      @if (!store.history().length) { <p class="empty-state">Ustvarite prvi plan za pregled zgodovine.</p> }
      @for (plan of store.history(); track plan.id) {
        <button class="history-row" (click)="store.openHistory(plan.id)" [disabled]="!!store.busy()">
          <span>Verzija {{ plan.version }}</span>
          <small>{{ strategies[plan.strategy].name }} · {{ plan.metrics.assigned }} nalog</small>
          <span class="status" [class.good]="plan.status === 'ACTIVE'">{{ plan.status === 'ACTIVE' ? 'Aktiven' : 'Prejšnji' }}</span>
        </button>
      }
      @for (item of store.recommendations(); track item.id) {
        @if (item.status === 'ACCEPTED' || item.status === 'REJECTED') {
          <div class="history-row decision-row">
            <span>{{ item.status === 'ACCEPTED' ? 'Potrjen predlog' : 'Zavrnjen predlog' }}</span>
            <small>{{ strategies[item.plan.strategy].name }}{{ item.decision_reason ? ' · ' + item.decision_reason : '' }}</small>
          </div>
        }
      }
    </section>
  `,
})
export class PlanHistory {
  readonly store = inject(DispatchStore);
  readonly strategies = strategies;
}
