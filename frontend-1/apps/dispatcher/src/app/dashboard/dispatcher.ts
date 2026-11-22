import { Component, computed, inject, signal } from '@angular/core';
import { clock, type Assignment } from '../../../../../packages/contracts';
import { DispatchStore } from '../core/dispatch-store';
import { issueLabels, priorityLabels } from '../core/labels';
import { PlanHistory } from '../history/plan-history';
import { IncidentCenter } from '../incidents/incident-center';
import { ReactViewHost } from '../react-host/react-view-host';
import { RecommendationComparison } from '../recommendations/recommendation-comparison';

@Component({
  selector: 'rescueflow-app',
  imports: [ReactViewHost, IncidentCenter, RecommendationComparison, PlanHistory],
  templateUrl: './dispatcher.html',
})
export class Dispatcher {
  readonly store = inject(DispatchStore);
  readonly clock = clock;
  readonly priorityLabels = priorityLabels;
  readonly issues = issueLabels;
  readonly selectedTask = signal('');
  readonly shownPlan = computed(() => this.store.preview() ?? this.store.state()?.active_plan ?? null);
  readonly assignments = computed(() => new Map(this.shownPlan()?.assignments.map(row => [row.task_id, row])));
  readonly affected = computed(() => this.store.state()?.baseline.affected ?? []);
  readonly riskIds = computed(() => new Set(this.affected().map(issue => issue.task_id)));
  readonly unassigned = computed(() => new Map(this.shownPlan()?.unassigned.map(issue => [issue.task_id, issue])));
  readonly operational = computed(() => this.store.state()?.vehicles.filter(vehicle =>
    vehicle.status !== 'BROKEN' && vehicle.status !== 'UNAVAILABLE').length ?? 0);
  readonly vehicleStatus: Record<string, string> = {
    AVAILABLE: 'Na voljo', UNAVAILABLE: 'Nedosegljivo', EN_ROUTE: 'Na poti na prevzem',
    TRANSPORTING: 'V prevozu', SERVICE: 'Predaja ali čiščenje', BROKEN: 'Okvara',
  };
  readonly equipment: Record<string, string> = { STRETCHER: 'Nosila', WHEELCHAIR: 'Voziček', OXYGEN: 'Kisik' };
  readonly sourceLabels: Record<string, string> = {
    SIMULATED: 'Simulirano', LIVE: 'Dosegljiv', STALE: 'Zastarel', UNAVAILABLE: 'Nedosegljiv',
  };
  private readonly sourceTime = new Intl.DateTimeFormat('sl-SI', {
    timeZone: 'Europe/Ljubljana', dateStyle: 'medium', timeStyle: 'short',
  });

  constructor() { this.store.initialize(); }

  focusTask(id: string) {
    this.selectedTask.set(id);
    requestAnimationFrame(() => {
      const row = document.getElementById(`task-${id}`);
      row?.focus({ preventScroll: true });
      row?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  taskStatus(row: Assignment | undefined, taskId: string) {
    if (!this.store.preview() && this.riskIds().has(taskId)) return 'Ogrožena';
    if (row?.status === 'COMPLETED') return 'Opravljena';
    if (row?.status === 'IN_PROGRESS') return 'V izvajanju';
    if (row?.is_locked) return 'Zaklenjena';
    if (row) return 'Dodeljena';
    return this.shownPlan() ? 'Nedodeljena' : 'Čaka na plan';
  }

  minutes(seconds: number) { return Math.round(seconds / 60); }

  facilityName(id: string) { return this.store.state()?.facilities.find(site => site.id === id)?.name ?? id; }
  observedAt(value: string) { return this.sourceTime.format(new Date(value)); }

}
