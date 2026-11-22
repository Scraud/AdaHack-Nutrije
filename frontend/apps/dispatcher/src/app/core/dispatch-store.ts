import { computed, Injectable, signal } from '@angular/core';
import type { DispatchState, IncidentInput, Recommendation, TrackingFrame, RoadMap, RoadSegment, Playback, SourceStatus } from '@rescueflow/contracts';
import { calculatePlanMetrics, candidateProblem, comparePlans, currentAssignment, passengerOnBoard } from '@rescueflow/contracts/plan-utils';
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
  readonly selectedTaskId = signal<string | null>(null);
  readonly selectedIncidentId = signal<string | null>(null);
  readonly lastCreatedIncidentId = signal<string | null>(null);
  readonly alertsOverride = signal<boolean | null>(null);
  readonly generationInfo = signal('');
  readonly selectedRecommendationId = signal<string | null>(null);
  readonly hoveredRecommendationId = signal<string | null>(null);
  readonly roads = signal<RoadMap|null>(null);
  readonly roadTarget = signal<RoadSegment|null>(null);
  readonly pickingRoad = signal(false);
  readonly tracking = signal<TrackingFrame|null>(null);
  readonly trackingOffline = signal(false);
  readonly sources = signal<SourceStatus[]>([]);
  readonly previewFrames = signal<Record<string,TrackingFrame>>({});
  readonly displayedTracking = computed(()=>{
    const state=this.state(),frame=this.previewPlan()?this.previewFrames()[this.previewPlan()!.id]:this.tracking();
    return frame&&frame.scenario_id===state?.scenario_id&&frame.revision===state.state_revision?frame:null;
  });
  private trackingTimer?: ReturnType<typeof setInterval>;
  private trackingPending=false;
  private mutation=0;
  readonly activePlan = computed(() => this.state()?.active_plan ?? null);
  readonly recommendations = computed(() => {
    const s = this.state();
    return s?.recommendations.filter(r => r.status==='PROPOSED' && r.base_plan_id===s.active_plan?.id && r.base_state_revision===s.state_revision && (this.gateway.isDemo ? r.is_fixture : !r.is_fixture && (r.solver_status==='FEASIBLE' || r.solver_status==='OPTIMAL')) && !!r.proposed_plan && !candidateProblem(s.active_plan,r.proposed_plan,s.tasks)).slice(0,3) ?? [];
  });
  readonly previewRecommendation = computed(() => this.recommendations().find(r => r.id === (this.hoveredRecommendationId() ?? this.selectedRecommendationId())) ?? null);
  readonly previewPlan = computed(() => this.previewRecommendation()?.proposed_plan ?? null);
  readonly displayedPlan = computed(() => this.previewPlan() ?? this.activePlan());
  readonly diff = computed(() => comparePlans(this.activePlan(),this.previewPlan()));
  readonly metrics = computed(() => calculatePlanMetrics(this.displayedPlan(),this.state()?.tasks ?? [],this.state()?.simulated_time ?? new Date().toISOString()));
  readonly activeVehicles = computed(() => this.state()?.vehicles.filter(v=>v.status!=='BROKEN' && v.status!=='UNAVAILABLE').length ?? 0);
  readonly openIncidents = computed(() => this.state()?.incidents.filter(i=>i.status!=='RESOLVED') ?? []);
  readonly selectedIncident = computed(()=>this.state()?.incidents.find(i=>i.id===this.selectedIncidentId())??null);
  readonly alertsVisible = computed(()=>this.alertsOverride()??(!!this.selectedIncident()||this.openIncidents().some(i=>!!(i.description.trim()||i.title.trim()))));
  readonly completed = computed(()=>this.activePlan()?.assignments.filter(a=>a.status==='COMPLETED').length??0);
  readonly summary = computed(()=>{
    const s=this.state(),m=calculatePlanMetrics(this.activePlan(),s?.tasks??[],s?.simulated_time??new Date().toISOString()),moving=s?.vehicles.filter(v=>passengerOnBoard(s,v.id)).length??0;
    return {past:`Opravljenih je ${this.completed()} od ${m.total} prevozov. ${s?.decisions.filter(d=>d.action==='ACCEPTED').length??0} odločitev je potrjenih.`,present:`${moving} vozil trenutno prevaža osebo. ${this.openIncidents().length} opozoril zahteva pregled.`,future:m.unassigned?`${m.unassigned} nalog še nima vozila. Pred potrditvijo preverite predloge in časovna okna.`:m.atRisk?`${m.atRisk} nalog je ogroženih. Preverite vpliv na naslednje prevoze.`:'Vse naloge so dodeljene. Spremljajte rezervo in prihodnje dogodke.'};
  });
  private toastTimer?: ReturnType<typeof setTimeout>;

  async init(gateway: DispatchGateway) {
    this.gateway = gateway; await this.refresh();
    await Promise.all([this.loadRoads(),this.refreshSources()]);
    if(typeof window!=='undefined'&&gateway.getTracking&&!this.trackingTimer)this.trackingTimer=setInterval(()=>void this.refreshTracking(),1000);
  }
  dispose(){clearInterval(this.trackingTimer);clearTimeout(this.toastTimer);this.mutation++;}
  async loadRoads(){try{this.roads.set(await this.gateway.getRoads?.()??null);}catch{this.roads.set(null);}}
  async refreshSources(refresh=false){try{this.sources.set(await this.gateway.getSources?.(refresh)??[]);}catch{if(refresh)this.error.set('Stanja zunanjih virov ni mogoče osvežiti.');}}
  async findStreet(name:string){try{const target=await this.gateway.findStreet?.(name);if(target){this.roadTarget.set(target);this.pickingRoad.set(false);this.error.set('');return true;}}catch(e){this.error.set(this.message(e));}return false;}
  async pickRoad(location:[number,number]){try{const target=await this.gateway.pickRoad?.(location);if(target){this.roadTarget.set(target);this.pickingRoad.set(false);this.error.set('');}}catch(e){this.error.set(this.message(e));}}
  async refreshTracking(force=false){
    if(!this.gateway.getTracking||this.trackingPending||(this.busy()&&!force))return;
    const mutation=this.mutation;this.trackingPending=true;
    try{
      const frame=await this.gateway.getTracking();
      if(mutation!==this.mutation)return;
      let state=this.state();
      if(!state||state.scenario_id!==frame.scenario_id||frame.revision>state.state_revision){
        const next=await this.gateway.getState();
        if(mutation!==this.mutation)return;
        this.state.set(next);state=next;this.clearPreview();this.previewFrames.set({});
      }
      if(state?.scenario_id===frame.scenario_id&&state.state_revision===frame.revision){
        this.tracking.set(frame);
        this.state.update(s=>s?{...s,vehicles:s.vehicles.map(v=>{const tracked=frame.vehicles.find(t=>t.id===v.id);return tracked?{...v,current_lat:tracked.location[0],current_lon:tracked.location[1],location_name:tracked.stale?'Zastarela lokacija GPS':`${tracked.location[0].toFixed(4)}, ${tracked.location[1].toFixed(4)}`}:v;})}:s);
      }
      this.trackingOffline.set(false);
    }catch{this.trackingOffline.set(true);}finally{this.trackingPending=false;}
  }
  private async loadPreviewFrames(){
    if(!this.gateway.getTracking)return;
    const state=this.state();if(!state)return;
    const frames=await Promise.all(this.recommendations().map(async rec=>{try{return [rec.proposed_plan.id,await this.gateway.getTracking!(rec.proposed_plan.id)] as const;}catch{return null;}}));
    if(this.state()?.scenario_id===state.scenario_id&&this.state()?.state_revision===state.state_revision)this.previewFrames.set(Object.fromEntries(frames.filter(item=>item!==null)));
  }
  async setPlayback(playing:boolean,speed:Playback['speed']=60){
    if(!this.gateway.setPlayback)return;
    return this.run(async()=>{await this.gateway.setPlayback!(playing,speed);this.clearPreview();return this.gateway.getState();});
  }
  async resolveIncident(id:string){if(!this.gateway.resolveIncident)return false;this.clearPreview();return this.run(()=>this.gateway.resolveIncident!(id));}
  async refresh() {
    this.mutation++;this.previewFrames.set({});
    this.loading.set(true); this.error.set('');
    try { this.state.set(await this.gateway.getState()); this.clearPreview(); await this.refreshTracking();await this.loadPreviewFrames(); }
    catch (e) { this.error.set(this.message(e)); }
    finally { this.loading.set(false); }
  }
  private message(e: unknown) { return e instanceof Error ? e.message : 'Dejanja ni bilo mogoče dokončati.'; }
  private async run(action: () => Promise<DispatchState>) {
    if (this.busy()) return false;
    this.busy.set(true); this.error.set('');
    this.mutation++;this.previewFrames.set({});
    try { this.state.set(await action()); await this.refreshTracking(true);return true; }
    catch (e) { this.error.set(this.message(e));try{this.state.set(await this.gateway.getState());}catch{/* Keep the last known state. */}return false; }
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
  async createIncident(input:IncidentInput) {
    this.clearPreview();this.generationInfo.set('');this.lastCreatedIncidentId.set(null);
    const before=new Set(this.state()?.incidents.map(i=>i.id));
    const success=await this.run(()=>this.gateway.createIncident(input));
    if(success){const newest=this.state()?.incidents.find(i=>!before.has(i.id));this.lastCreatedIncidentId.set(newest?.id??null);this.closeIncident();this.alertsOverride.set(null);this.toast('Dogodek je zabeležen. Za rešitve kliknite opozorilo.');}
    return success;
  }
  async generate(id: string) {
    this.clearPreview();this.generationInfo.set('');
    const success=await this.run(()=>this.gateway.generateRecommendations(id,this.state()!));
    if(success)await this.loadPreviewFrames();
    if(success)this.generationInfo.set(this.recommendations().length?`Na voljo: ${this.recommendations().length} različnih potrdivnih predlogov.`:'Izračun ni vrnil potrdivnega predloga. Preverite blokirajoče omejitve ali ponovno poskusite; iztek časa ni dokaz neizvedljivosti.');
    return success;
  }
  async generateInitialPlan() { return this.run(()=>this.gateway.generateInitialPlan()); }
  async restoreVehicle(id:string){this.clearPreview();if(await this.run(()=>this.gateway.restoreVehicle(id))){this.generationInfo.set('');this.toast(`${id}: okvara je odpravljena. Vozilo je znova na voljo za razporejanje.`);return true;}return false;}
  async advanceTime(to:string){this.clearPreview();return this.run(()=>this.gateway.advanceTime(to));}
  async prepareDemo(){
    if(!this.activePlan()&&!await this.generateInitialPlan())return;
    const s=this.state()!;const at=new Date(Date.parse(s.horizon_start)+200*60_000).toISOString();
    if(Date.parse(s.simulated_time)<Date.parse(at))await this.advanceTime(at);
  }
  hover(id: string | null) { this.hoveredRecommendationId.set(id); }
  pin(id: string) { this.selectedRecommendationId.set(id); this.hoveredRecommendationId.set(null); }
  clearPreview() { this.selectedRecommendationId.set(null); this.hoveredRecommendationId.set(null); }
  selectVehicle(id: string) { this.selectedVehicleId.update(old=>old===id ? null : id); }
  selectTask(id:string){this.selectedTaskId.set(id);const a=this.displayedPlan()?.assignments.find(a=>a.task_id===id);if(a)this.selectedVehicleId.set(a.vehicle_id);}
  inspectIncident(id:string){this.selectedIncidentId.set(id);this.alertsOverride.set(true);this.clearPreview();this.generationInfo.set('');}
  toggleIncident(id:string){if(this.selectedIncidentId()===id)this.closeIncident();else this.inspectIncident(id);}
  toggleAlerts(){const visible=!this.alertsVisible();this.alertsOverride.set(visible);if(!visible)this.closeIncident();}
  closeIncident(){this.selectedIncidentId.set(null);this.clearPreview();}
  async accept(recommendation: Recommendation) {
    if (await this.run(()=>this.gateway.accept(recommendation.id,this.state()!))) {
      this.clearPreview(); this.toast(this.gateway.isDemo ? 'Vzorčni plan je potrjen. Zemljevid in urnik sta posodobljena.' : 'Predlog je potrjen. Aktivni plan je posodobljen.');
    }
  }
  async reject(id: string) { if (await this.run(()=>this.gateway.reject(id,this.state()!))) { this.clearPreview(); this.toast('Predlog je zavrnjen.'); } }
  async reset() { if (await this.run(()=>this.gateway.reset())) { this.clearPreview(); this.selectedVehicleId.set(null);this.selectedIncidentId.set(null);this.lastCreatedIncidentId.set(null);this.alertsOverride.set(null);this.selectedTaskId.set(null);this.generationInfo.set(''); this.toast('Simulacija je ponastavljena.'); } }
  toast(message: string) { this.notification.set(message); clearTimeout(this.toastTimer); this.toastTimer=setTimeout(()=>this.notification.set(''),5000); }
  currentAssignment(id: string) { return this.state() ? currentAssignment(this.state()!,this.displayedPlan(),id) : undefined; }
  upcoming(id: string) { return this.displayedPlan()?.assignments.filter(a=>a.vehicle_id===id && Date.parse(a.planned_end)>Date.parse(this.state()!.simulated_time)).sort((a,b)=>Date.parse(a.planned_departure)-Date.parse(b.planned_departure)) ?? []; }
}
