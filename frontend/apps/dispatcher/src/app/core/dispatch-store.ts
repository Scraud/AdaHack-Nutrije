import { computed, Injectable, signal } from '@angular/core';
import type { DispatchState, Recommendation } from '@rescueflow/contracts';
import { calculatePlanMetrics, candidateProblem, comparePlans, currentAssignment } from '@rescueflow/contracts/plan-utils';
import type { DispatchGateway } from './dispatch-api';

@Injectable({ providedIn:'root' })
export class DispatchStore {
  gateway!: DispatchGateway;
  readonly state = signal<DispatchState | null>(null);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly notification = signal('');
  readonly selectedVehicleId = signal<string | null>(null);
  readonly selectedRecommendationId = signal<string | null>(null);
  readonly hoveredRecommendationId = signal<string | null>(null);
  readonly activePlan = computed(() => this.state()?.active_plan ?? null);
  readonly recommendations = computed(() => {
    const s = this.state();
    return s?.recommendations.filter(r => r.status==='PROPOSED' && r.base_plan_id===s.active_plan?.id && r.base_state_revision===s.state_revision && (this.gateway.isDemo ? r.is_fixture : !r.is_fixture && (r.solver_status==='FEASIBLE' || r.solver_status==='OPTIMAL')) && !!r.proposed_plan && !candidateProblem(s.active_plan,r.proposed_plan,s.tasks)) ?? [];
  });
  readonly previewRecommendation = computed(() => this.recommendations().find(r => r.id === (this.hoveredRecommendationId() ?? this.selectedRecommendationId())) ?? null);
  readonly previewPlan = computed(() => this.previewRecommendation()?.proposed_plan ?? null);
  readonly displayedPlan = computed(() => this.previewPlan() ?? this.activePlan());
  readonly diff = computed(() => comparePlans(this.activePlan(),this.previewPlan()));
  readonly metrics = computed(() => calculatePlanMetrics(this.displayedPlan(),this.state()?.tasks ?? [],this.state()?.simulated_time ?? new Date().toISOString()));
  readonly activeVehicles = computed(() => this.state()?.vehicles.filter(v=>v.status!=='BROKEN' && v.status!=='UNAVAILABLE').length ?? 0);
  readonly openIncidents = computed(() => this.state()?.incidents.filter(i=>i.status!=='RESOLVED') ?? []);
  private toastTimer?: ReturnType<typeof setTimeout>;

  async init(gateway: DispatchGateway) { this.gateway = gateway; await this.refresh(); }
  async refresh() {
    this.loading.set(true); this.error.set('');
    try { this.state.set(await this.gateway.getState()); this.clearPreview(); }
    catch (e) { this.error.set(this.message(e)); }
    finally { this.loading.set(false); }
  }
  private message(e: unknown) { return e instanceof Error ? e.message : 'Dejanja ni bilo mogoče dokončati.'; }
  private async run(action: () => Promise<DispatchState>) {
    if (this.busy()) return false;
    this.busy.set(true); this.error.set('');
    try { this.state.set(await action()); return true; }
    catch (e) { this.error.set(this.message(e)); return false; }
    finally { this.busy.set(false); }
  }
  async simulateIncident() {
    if (this.openIncidents().length) return this.generate(this.openIncidents()[0].id);
    const success = await this.run(() => this.gateway.createIncident({incident_type:'NEW_TASK',priority:'P1',scenario:'priority_transport_1120'}));
    if (success) {
      const incident = this.openIncidents().at(-1);
      if (incident) await this.generate(incident.id);
    }
  }
  async generate(id: string) { this.clearPreview(); await this.run(()=>this.gateway.generateRecommendations(id,this.state()!)); }
  async generateInitialPlan() { await this.run(()=>this.gateway.generateInitialPlan()); }
  hover(id: string | null) { this.hoveredRecommendationId.set(id); }
  pin(id: string) { this.selectedRecommendationId.set(id); this.hoveredRecommendationId.set(null); }
  clearPreview() { this.selectedRecommendationId.set(null); this.hoveredRecommendationId.set(null); }
  selectVehicle(id: string) { this.selectedVehicleId.update(old=>old===id ? null : id); }
  async accept(recommendation: Recommendation) {
    if (await this.run(()=>this.gateway.accept(recommendation.id,this.state()!))) {
      this.clearPreview(); this.toast(this.gateway.isDemo ? 'Vzorčni plan je potrjen. Zemljevid in urnik sta posodobljena.' : 'Predlog je potrjen. Aktivni plan je posodobljen.');
    }
  }
  async reject(id: string) { if (await this.run(()=>this.gateway.reject(id,this.state()!))) { this.clearPreview(); this.toast('Predlog je zavrnjen.'); } }
  async reset() { if (await this.run(()=>this.gateway.reset())) { this.clearPreview(); this.selectedVehicleId.set(null); this.toast('Simulacija je ponastavljena.'); } }
  toast(message: string) { this.notification.set(message); clearTimeout(this.toastTimer); this.toastTimer=setTimeout(()=>this.notification.set(''),5000); }
  currentAssignment(id: string) { return this.state() ? currentAssignment(this.state()!,this.displayedPlan(),id) : undefined; }
  upcoming(id: string) { return this.displayedPlan()?.assignments.filter(a=>a.vehicle_id===id && Date.parse(a.planned_end)>Date.parse(this.state()!.simulated_time)).sort((a,b)=>Date.parse(a.planned_departure)-Date.parse(b.planned_departure)) ?? []; }
}
