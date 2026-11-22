import { computed, Injectable, signal } from '@angular/core';
import type { DispatchState, Incident, IncidentInput, NewVehicleInput, Recommendation, RecommendationInsight, VehicleSettings, TrackingFrame, RoadMap, RoadSegment, Playback, SourceStatus } from '@rescueflow/contracts';
import { calculatePlanMetrics, candidateProblem, comparePlans, currentAssignment, passengerOnBoard, STRATEGY_ORDER } from '@rescueflow/contracts/plan-utils';
import type { DispatchGateway } from './dispatch-api';

@Injectable({ providedIn:'root' })
export class DispatchStore {
  gateway!: DispatchGateway;
  readonly state = signal<DispatchState | null>(null);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly notification = signal('');
  readonly urgentNotices=computed(()=>this.openIncidents().filter(i=>i.incident_type==='NEW_TASK'||i.incident_type==='VEHICLE_BREAKDOWN'||i.incident_type==='FLEET_CHANGE'));
  readonly roadNotices=signal<{id:string;text:string}[]>([]);
  private seenRoadNotices=new Set<string>();
  private roadNoticeTimers=new Map<string,ReturnType<typeof setTimeout>>();
  private locationCache=new Map<string,{lat:number;lon:number;name:string}>();
  private locationPending=new Set<string>();
  readonly selectedVehicleId = signal<string | null>(null);
  readonly selectedTaskId = signal<string | null>(null);
  readonly selectedIncidentId = signal<string | null>(null);
  readonly lastCreatedIncidentId = signal<string | null>(null);
  readonly alertsOverride = signal<boolean | null>(null);
  readonly generationInfo = signal('');
  readonly selectedRecommendationId = signal<string | null>(null);
  readonly hoveredRecommendationId = signal<string | null>(null);
  readonly insights = signal<Record<string,RecommendationInsight|null>>({});
  readonly insightLoading = signal<string|null>(null);
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
    return s?.recommendations.filter(r => r.status==='PROPOSED' && r.base_plan_id===s.active_plan?.id && r.base_state_revision===s.state_revision && (this.gateway.isDemo ? r.is_fixture : !r.is_fixture && (r.solver_status==='FEASIBLE' || r.solver_status==='OPTIMAL')) && !!r.proposed_plan && !candidateProblem(s.active_plan,r.proposed_plan,s)).sort((a,b)=>(STRATEGY_ORDER[a.strategy]??3)-(STRATEGY_ORDER[b.strategy]??3)).slice(0,3) ?? [];
  });
  readonly previewRecommendation = computed(() => this.recommendations().find(r => r.id === (this.hoveredRecommendationId() ?? this.selectedRecommendationId())) ?? null);
  readonly previewPlan = computed(() => this.previewRecommendation()?.proposed_plan ?? null);
  readonly displayedPlan = computed(() => this.previewPlan() ?? this.activePlan());
  readonly diff = computed(() => comparePlans(this.activePlan(),this.previewPlan()));
  readonly metrics = computed(() => calculatePlanMetrics(this.displayedPlan(),this.state()?.tasks ?? [],this.state()?.simulated_time ?? new Date().toISOString()));
  readonly activeVehicles = computed(() => this.state()?.vehicles.filter(v=>v.status!=='BROKEN' && v.status!=='UNAVAILABLE').length ?? 0);
  readonly openIncidents = computed(() => this.state()?.incidents.filter(i=>i.status!=='RESOLVED') ?? []);
  readonly selectedIncident = computed(()=>this.state()?.incidents.find(i=>i.id===this.selectedIncidentId())??null);
  readonly alertsVisible = computed(()=>this.alertsOverride()??(!!this.selectedIncident()||this.openIncidents().some(i=>!this.isRoadIncident(i)&&!!(i.description.trim()||i.title.trim()))));
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
  dispose(){clearInterval(this.trackingTimer);clearTimeout(this.toastTimer);for(const timer of this.roadNoticeTimers.values())clearTimeout(timer);this.mutation++;}
  isRoadIncident(incident:Incident){return incident.incident_type==='TRAFFIC_DELAY'||incident.incident_type==='ROAD_CLOSURE';}
  dismissRoadNotice(id:string){clearTimeout(this.roadNoticeTimers.get(id));this.roadNoticeTimers.delete(id);this.roadNotices.update(items=>items.filter(item=>item.id!==id));}
  showRoadNotice(incident:Incident){
    const id=`${this.state()?.scenario_id}:${incident.id}`;
    this.dismissRoadNotice(id);this.roadNotices.update(items=>[...items,{id,text:`${incident.title}: ${incident.description} Obvoz in časi prihoda se posodobijo samodejno.`}]);
    this.roadNoticeTimers.set(id,setTimeout(()=>this.dismissRoadNotice(id),8000));
  }
  private observeIncidents(){
    const state=this.state();if(!state)return;
    for(const event of state.incidents.filter(i=>this.isRoadIncident(i)&&i.status!=='RESOLVED')){
      const key=`${state.scenario_id}:${event.id}`;
      if(!this.seenRoadNotices.has(key)){this.seenRoadNotices.add(key);this.showRoadNotice(event);}
    }
    this.roadNotices.update(items=>items.filter(item=>state.incidents.some(i=>item.id===`${state.scenario_id}:${i.id}`&&i.status!=='RESOLVED')));
  }
  private async refreshVehicleLocations(){
    const state=this.state();if(!state||!this.gateway.pickRoad)return;
    const mutation=this.mutation;
    await Promise.all(state.vehicles.map(async vehicle=>{
      const key=`${state.scenario_id}:${vehicle.id}`,cached=this.locationCache.get(key);
      const near=(lat:number,lon:number)=>Math.hypot(lat-vehicle.current_lat,(lon-vehicle.current_lon)*.7)<.0015;
      if(this.locationPending.has(key))return;
      if(cached&&near(cached.lat,cached.lon)){
        this.state.update(s=>s?{...s,vehicles:s.vehicles.map(v=>v.id===vehicle.id?{...v,location_name:cached.name}:v)}:s);return;
      }
      this.locationPending.add(key);
      try{
        const road=await this.gateway.pickRoad!([vehicle.current_lat,vehicle.current_lon]);
        if(mutation!==this.mutation||this.state()?.scenario_id!==state.scenario_id)return;
        this.locationCache.set(key,{lat:vehicle.current_lat,lon:vehicle.current_lon,name:road.name});
        this.state.update(s=>s?{...s,vehicles:s.vehicles.map(v=>v.id===vehicle.id&&near(v.current_lat,v.current_lon)?{...v,location_name:road.name}:v)}:s);
      }catch{/* Keep the last known street or area when a lookup fails. */}finally{this.locationPending.delete(key);}
    }));
  }
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
        this.state.update(s=>s?{...s,vehicles:s.vehicles.map(v=>{const tracked=frame.vehicles.find(t=>t.id===v.id);return tracked?{...v,current_lat:tracked.location[0],current_lon:tracked.location[1]}:v;})}:s);
      }
      this.observeIncidents();await this.refreshVehicleLocations();
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
  private async ensureInitialPlan(state:DispatchState):Promise<DispatchState>{
    if(state.active_plan)return state;
    try{return await this.gateway.generateInitialPlan();}
    catch(error){
      // Another dispatcher may have prepared the plan while this client was loading.
      const latest=await this.gateway.getState();
      if(latest.active_plan)return latest;
      throw error;
    }
  }
  async refresh() {
    if(this.busy())return;
    this.mutation++;this.previewFrames.set({});
    this.loading.set(true); this.busy.set(true); this.error.set('');
    try { const state=await this.gateway.getState();this.state.set(state);this.state.set(await this.ensureInitialPlan(state));this.observeIncidents();this.clearPreview(); await this.refreshTracking(true);await this.loadPreviewFrames(); }
    catch (e) { this.error.set(this.message(e)); }
    finally { this.busy.set(false);this.loading.set(false); }
  }
  async refreshDemo(){
    const repaired:string[]=[];
    let cleared=0;
    const success=await this.run(async()=>{
      let state=await this.gateway.getState();
      if(this.tracking()?.mode!=='GPS')for(const vehicle of state.vehicles.filter(v=>v.status==='BROKEN')){
        state=await this.gateway.restoreVehicle(vehicle.id);repaired.push(vehicle.id);
      }
      if(this.tracking()?.mode!=='GPS'&&this.gateway.resolveIncident){
        // Road events may be marked handled while the physical disruption is still active.
        const roads=state.backend?.incidents.filter(i=>(i.type==='TRAFFIC_DELAY'||i.type==='ROAD_CLOSURE')&&i.ended_at==null&&(i.duration==null||state.backend!.now<i.occurred_at+i.duration)).map(i=>String(i.id))
          ??state.incidents.filter(i=>this.isRoadIncident(i)&&i.status!=='RESOLVED').map(i=>i.id);
        for(const id of roads){state=await this.gateway.resolveIncident(id);cleared++;}
      }
      return this.ensureInitialPlan(state);
    });
    if(success){this.clearPreview();this.roadTarget.set(null);await this.loadPreviewFrames();if(repaired.length||cleared)this.toast(`Demo osvežen: ${repaired.length} odpravljenih okvar, ${cleared} odstranjenih prometnih motenj.`);}
    return success;
  }
  private message(e: unknown) { return e instanceof Error ? e.message : 'Dejanja ni bilo mogoče dokončati.'; }
  private async run(action: () => Promise<DispatchState>) {
    if (this.busy()) return false;
    this.busy.set(true); this.error.set('');
    this.mutation++;this.previewFrames.set({});
    try { this.state.set(await action());this.observeIncidents(); await this.refreshTracking(true);return true; }
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
    if(success){const newest=this.state()?.incidents.find(i=>!before.has(i.id));this.lastCreatedIncidentId.set(newest?.id??null);this.closeIncident();this.alertsOverride.set(null);if(newest&&!this.isRoadIncident(newest)&&!['NEW_TASK','VEHICLE_BREAKDOWN'].includes(newest.incident_type))this.toast('Dogodek je zabeležen.');}
    return success;
  }
  async createTask(input:import('@rescueflow/contracts').ScheduledTaskInput){
    if(!this.gateway.createTask){this.error.set('Za shranjevanje novih nalog povežite backend.');return null;}
    const before=new Set([...(this.state()?.tasks??[]),...(this.state()?.future_tasks??[])].map(task=>task.id));
    const success=await this.run(()=>this.gateway.createTask!(input));
    if(!success)return null;
    const state=this.state()!,created=[...state.tasks,...state.future_tasks??[]].find(task=>!before.has(task.id));
    if(!created)return null;
    const incident=state.incidents.find(event=>event.affected_task_ids.includes(created.id));
    this.toast(incident?'Naloga je v naslednjih 24 urah. Preglejte predloge razporeda.':'Naloga je shranjena za prihodnost; trenutni routing ostane nespremenjen.');
    return {taskId:created.id,incidentId:incident?.id??null};
  }
  async generate(id: string) {
    if(this.state()?.incidents.some(i=>i.id===id&&this.isRoadIncident(i)))return false;
    this.clearPreview();this.generationInfo.set('');
    const success=await this.run(()=>this.gateway.generateRecommendations(id,this.state()!));
    if(success)await this.loadPreviewFrames();
    if(success)this.generationInfo.set(this.recommendations().length?`Na voljo: ${this.recommendations().length} različnih potrdivnih predlogov.`:'Izračun ni vrnil potrdivnega predloga. Preverite blokirajoče omejitve ali ponovno poskusite; iztek časa ni dokaz neizvedljivosti.');
    return success;
  }
  async generateInitialPlan() { return this.run(()=>this.gateway.generateInitialPlan()); }
  async regeneratePlan(){
    this.closeIncident();this.generationInfo.set('');
    if(!this.activePlan())return this.run(async()=>this.ensureInitialPlan(await this.gateway.getState()));
    if(!await this.generate(''))return false;
    const rec=this.recommendations().find(r=>r.strategy==='MIN_DELAY')??this.recommendations()[0];
    if(!rec){this.error.set(this.generationInfo());return false;}
    const success=await this.run(()=>this.gateway.accept(rec.id,this.state()!,'Ročna regeneracija plana.'));
    if(success){this.clearPreview();this.toast('Plan je posodobljen.');}
    return success;
  }
  async addVehicle(input:NewVehicleInput){if(!this.gateway.addVehicle)return false;this.clearPreview();const before=new Set(this.state()?.vehicles.map(v=>v.id));if(await this.run(()=>this.gateway.addVehicle!(input))){const added=this.state()?.vehicles.find(v=>!before.has(v.id));this.generationInfo.set('');this.noteFleetChange(`${added?.id??'Vozilo'} je dodano v floto.`);return true;}return false;}
  async updateVehicle(id:string,input:VehicleSettings){if(!this.gateway.updateVehicle)return false;this.clearPreview();if(await this.run(()=>this.gateway.updateVehicle!(id,input))){this.generationInfo.set('');this.noteFleetChange(`${id}: oprema in vrste nalog so posodobljene.`);return true;}return false;}
  async removeVehicle(id:string){if(!this.gateway.removeVehicle)return false;this.clearPreview();if(await this.run(()=>this.gateway.removeVehicle!(id))){if(this.selectedVehicleId()===id)this.selectedVehicleId.set(null);this.generationInfo.set('');this.noteFleetChange(`${id} je odstranjeno iz flote.`);return true;}return false;}
  private noteFleetChange(message:string){const change=this.openIncidents().filter(i=>i.incident_type==='FLEET_CHANGE').at(-1);this.lastCreatedIncidentId.set(change?.id??null);this.alertsOverride.set(null);this.toast(`${message} Za prerazporeditev kliknite opozorilo »Sprememba flote«.`);}
  async restoreVehicle(id:string){this.clearPreview();if(await this.run(()=>this.gateway.restoreVehicle(id))){this.generationInfo.set('');this.toast(`${id}: okvara je odpravljena. Vozilo je znova na voljo za razporejanje.`);return true;}return false;}
  async advanceTime(to:string){
    const rewind=Date.parse(to)<Date.parse(this.state()?.simulated_time??to);this.clearPreview();
    const success=await this.run(()=>this.gateway.advanceTime(to));
    if(success&&rewind){this.closeIncident();this.selectedTaskId.set(null);this.lastCreatedIncidentId.set(null);this.selectedVehicleId.set(null);this.roadTarget.set(null);this.alertsOverride.set(null);this.generationInfo.set('');this.toast('Demo je znova pripravljen do izbrane ure. Dodani dogodki in odločitve so ponastavljeni.');}
    return success;
  }
  async prepareDemo(){
    if(!this.activePlan()&&!await this.generateInitialPlan())return;
    const s=this.state()!;const at=new Date(Date.parse(s.horizon_start)+200*60_000).toISOString();
    if(Date.parse(s.simulated_time)<Date.parse(at))await this.advanceTime(at);
  }
  hover(id: string | null) { this.hoveredRecommendationId.set(id); }
  pin(id: string) { this.selectedRecommendationId.set(id); this.hoveredRecommendationId.set(null); void this.loadInsight(id); }
  async loadInsight(id:string){
    if(!this.gateway.explain||this.insights()[id]||this.insightLoading()===id)return;
    this.insightLoading.set(id);
    try{const insight=await this.gateway.explain(id);this.insights.update(all=>({...all,[id]:insight}));}
    catch{this.insights.update(all=>({...all,[id]:null}));}
    finally{if(this.insightLoading()===id)this.insightLoading.set(null);}
  }
  clearPreview() { this.selectedRecommendationId.set(null); this.hoveredRecommendationId.set(null); }
  selectVehicle(id: string) { this.selectedVehicleId.update(old=>old===id ? null : id); }
  selectTask(id:string){this.selectedTaskId.set(id);const a=this.displayedPlan()?.assignments.find(a=>a.task_id===id);if(a)this.selectedVehicleId.set(a.vehicle_id);}
  inspectIncident(id:string){this.selectedIncidentId.set(id);this.alertsOverride.set(true);this.clearPreview();this.generationInfo.set('');}
  toggleIncident(id:string){if(this.selectedIncidentId()===id)this.closeIncident();else this.inspectIncident(id);}
  toggleAlerts(){const visible=!this.alertsVisible();this.alertsOverride.set(visible);if(!visible)this.closeIncident();}
  closeIncident(){this.selectedIncidentId.set(null);this.clearPreview();}
  async accept(recommendation: Recommendation) {
    const success=await this.run(()=>this.gateway.accept(recommendation.id,this.state()!));
    if (success) {
      this.clearPreview(); this.toast(this.gateway.isDemo ? 'Vzorčni plan je potrjen. Zemljevid in urnik sta posodobljena.' : 'Predlog je potrjen. Aktivni plan je posodobljen.');
    }
    return success;
  }
  async reject(id: string) {
    const selected=this.selectedRecommendationId(),hovered=this.hoveredRecommendationId();
    const success=await this.run(()=>this.gateway.reject(id,this.state()!));
    if(success){
      const incident=this.selectedIncidentId();
      const available=this.recommendations().filter(rec=>!incident||rec.incident_id===incident||rec.incident_ids?.includes(incident));
      const next=available.find(rec=>rec.id===selected)||available.find(rec=>rec.id===hovered)||available[0];
      if(next)this.pin(next.id);else this.clearPreview();
      this.toast('Predlog je zavrnjen.');
    }
    await this.loadPreviewFrames();
    return success;
  }
  async reset() { if (await this.run(async()=>this.ensureInitialPlan(await this.gateway.reset()))) { this.clearPreview(); this.selectedVehicleId.set(null);this.selectedIncidentId.set(null);this.lastCreatedIncidentId.set(null);this.alertsOverride.set(null);this.selectedTaskId.set(null);this.generationInfo.set(''); this.toast('Simulacija je ponastavljena.'); } }
  toast(message: string) { this.notification.set(message); clearTimeout(this.toastTimer); this.toastTimer=setTimeout(()=>this.notification.set(''),5000); }
  currentAssignment(id: string) { return this.state() ? currentAssignment(this.state()!,this.displayedPlan(),id) : undefined; }
  upcoming(id: string) { return this.displayedPlan()?.assignments.filter(a=>a.vehicle_id===id && Date.parse(a.planned_end)>Date.parse(this.state()!.simulated_time)).sort((a,b)=>Date.parse(a.planned_departure)-Date.parse(b.planned_departure)) ?? []; }
}
