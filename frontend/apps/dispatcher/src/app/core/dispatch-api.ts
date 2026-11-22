import type { DispatchState, IncidentInput, RuntimeConfig, TrackingFrame, RoadMap, RoadSegment, Playback, SourceStatus, Location, RecommendationInsight, NewVehicleInput, VehicleSettings } from '@rescueflow/contracts';
import { createDemoState, createFixtureRecommendations, demoTime } from './demo-data';
import { adaptBackendState, type BackendState, type BackendRecommendation } from './backend-adapter';
import type { components } from '@rescueflow/contracts/api';
import { ROAD_EVENT_DEFAULTS } from '@rescueflow/contracts';

export interface DispatchGateway {
  readonly isDemo: boolean;
  createTask?(input:import('@rescueflow/contracts').ScheduledTaskInput):Promise<DispatchState>;
  recoverEquipment?(vehicleId:string,input:import('@rescueflow/contracts').EquipmentRecoveryInput):Promise<DispatchState>;
  getState(): Promise<DispatchState>;
  generateInitialPlan(): Promise<DispatchState>;
  advanceTime(to: string): Promise<DispatchState>;
  createIncident(input: IncidentInput): Promise<DispatchState>;
  restoreVehicle(id:string): Promise<DispatchState>;
  generateRecommendations(incidentId: string, state: DispatchState): Promise<DispatchState>;
  accept(id: string, state: DispatchState, reason?: string): Promise<DispatchState>;
  reject(id: string, state: DispatchState): Promise<DispatchState>;
  reset(): Promise<DispatchState>;
  getTracking?(planId?:string): Promise<TrackingFrame>;
  getRoads?(): Promise<RoadMap>;
  findStreet?(name:string): Promise<RoadSegment>;
  findAddresses?(query:string): Promise<Location[]>;
  pickRoad?(location:[number,number]): Promise<RoadSegment>;
  setPlayback?(playing:boolean,speed:Playback['speed']): Promise<Playback>;
  resolveIncident?(id:string): Promise<DispatchState>;
  getSources?(refresh?:boolean): Promise<SourceStatus[]>;
  explain?(id:string): Promise<RecommendationInsight>;
  addVehicle?(input:NewVehicleInput): Promise<DispatchState>;
  updateVehicle?(id:string,input:VehicleSettings): Promise<DispatchState>;
  removeVehicle?(id:string): Promise<DispatchState>;
}

export class HttpDispatchGateway implements DispatchGateway {
  readonly isDemo = false;
  constructor(private readonly baseUrl: string) {}
  private async request<T>(path: string, body?: unknown, timeout = 30_000, method?: 'PUT' | 'DELETE'): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'), credentials:'same-origin',
      headers: { Accept:'application/json', ...(body === undefined ? {} : { 'Content-Type':'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      if (response.status === 409) {
        const conflict = await response.json().catch(() => null);
        if (['VEHICLE_IN_USE','STALE_STATE','VEHICLE_NOT_BROKEN','BREAKDOWN_REQUIRED','EQUIPMENT_ALREADY_REQUESTED'].includes(conflict?.detail?.code) &&
            typeof conflict.detail.message === 'string') throw new Error(conflict.detail.message);
        throw new Error('Stanje se je spremenilo. Osvežite podatke in ponovno izračunajte predloge.');
      }
      let detail = '';
      try { const json = await response.json(); if (typeof json.detail === 'string') detail = json.detail; else if(typeof json.detail?.message==='string')detail=json.detail.message; else if(response.status===422)detail='Preverite obvezne podatke in časovna okna.'; } catch { /* Non-JSON upstream response. */ }
      throw new Error(detail || `Povezava z zaledjem ni uspela (HTTP ${response.status}).`);
    }
    return response.status === 204 ? undefined as T : response.json();
  }
  async getState() {
    const [state, recommendations,history] = await Promise.all([this.request<BackendState>('/state'),this.request<BackendRecommendation[]>('/recommendations'),this.request<components['schemas']['PlanSummary'][]>('/plans')]);
    if (!Array.isArray(recommendations)) throw new Error('Odziv /api/recommendations mora biti seznam predlogov s celotnimi plani.');
    return adaptBackendState(state,recommendations,history);
  }
  private async mutate(path: string, body: unknown) { await this.request(path, body); return this.getState(); }
  generateInitialPlan() { return this.mutate('/plans/generate', {}); }
  createTask(input:import('@rescueflow/contracts').ScheduledTaskInput){return this.mutate('/tasks',input);}
  recoverEquipment(vehicleId:string,input:import('@rescueflow/contracts').EquipmentRecoveryInput){return this.mutate(`/vehicles/${encodeURIComponent(vehicleId)}/equipment-recovery`,input);}
  restoreVehicle(id:string){return this.mutate(`/vehicles/${encodeURIComponent(id)}/restore`,{});}
  addVehicle(input:NewVehicleInput){return this.mutate('/vehicles',input);}
  async updateVehicle(id:string,input:VehicleSettings){await this.request(`/vehicles/${encodeURIComponent(id)}`,input,30_000,'PUT');return this.getState();}
  async removeVehicle(id:string){await this.request(`/vehicles/${encodeURIComponent(id)}`,undefined,30_000,'DELETE');return this.getState();}
  getTracking(planId?:string){return this.request<TrackingFrame>(`/tracking${planId?'?plan_id='+encodeURIComponent(planId):''}`);}
  getRoads(){return this.request<RoadMap>('/map/roads');}
  findStreet(name:string){return this.request<RoadSegment>(`/map/roads/street?name=${encodeURIComponent(name.trim())}`);}
  findAddresses(query:string){return this.request<Location[]>(`/map/addresses?query=${encodeURIComponent(query)}`);}
  pickRoad([lat,lon]:[number,number]){return this.request<RoadSegment>(`/map/roads/nearest?lat=${lat}&lon=${lon}`);}
  setPlayback(playing:boolean,speed:Playback['speed']){return this.request<Playback>('/tracking/playback',{playing,speed});}
  resolveIncident(id:string){return this.mutate(`/incidents/${encodeURIComponent(id)}/resolve`,{});}
  getSources(refresh=false){return this.request<SourceStatus[]>(`/conditions${refresh?'/refresh':''}`,refresh?{}:undefined);}
  // A local model can need a while to load on first use.
  explain(id:string){return this.request<RecommendationInsight>(`/recommendations/${encodeURIComponent(id)}/explanation`,undefined,120_000);}
  async advanceTime(to:string){
    const state=await this.request<BackendState>('/state');
    const seconds=Math.round((Date.parse(to)-Date.parse(state.start_at))/1000);
    if(!Number.isFinite(seconds)||seconds< -8*3600||seconds>=16*3600)throw new Error('Izberite veljavno uro med 00:00 in 23:59.');
    if(seconds===state.now)return this.getState();
    if(seconds<state.now){
      await this.request('/demo/reset',{});
      await this.request('/plans/generate',{});
      if(seconds===0)return this.getState();
    }
    return this.mutate('/demo/clock',{to:seconds});
  }
  async createIncident(input: IncidentInput) {
    if(input.incident_type==='TRAFFIC_DELAY'||input.incident_type==='ROAD_CLOSURE')input={...ROAD_EVENT_DEFAULTS,...input};
    const body:components['schemas']['CreateIncident']={type:input.incident_type,description:input.description??'',priority:input.priority,
      vehicle_id:input.affected_vehicle_id,road_id:input.road_id,duration:input.duration_minutes?input.duration_minutes*60:undefined,multiplier:input.delay_multiplier,location:input.location?{lat:input.location.lat,lon:input.location.lon}:undefined};
    if(input.task){
      const {pickup,passenger_count,equipment,earliest_pickup}=input.task;
      body.task={priority:input.priority,pickup:{lat:pickup.lat,lon:pickup.lon},pickup_name:pickup.name,passenger_count,equipment};
      if(earliest_pickup){
        const state=await this.request<BackendState>('/state');
        body.task.earliest_pickup=Math.round((Date.parse(earliest_pickup)-Date.parse(state.start_at))/1000);
      }
    }else if(input.incident_type==='NEW_TASK'){
      body.task={priority:input.priority,pickup:{lat:46.068,lon:14.542},pickup_name:'Simulirana lokacija prevzema',passenger_count:1,equipment:['OXYGEN']};
    }
    return this.mutate('/incidents',body);
  }
  async generateRecommendations(_incidentId: string, _state: DispatchState) {
    await this.setPlayback(false,60);
    const state=await this.getState();
    return this.mutate('/recommendations/generate', { base_plan_id:state.active_plan?.id, expected_state_revision:state.state_revision });
  }
  accept(id: string, _state: DispatchState) { return this.mutate(`/recommendations/${encodeURIComponent(id)}/accept`, {}); }
  reject(id: string, _state: DispatchState) { return this.mutate(`/recommendations/${encodeURIComponent(id)}/reject`, { reason:'Predlog zavrnjen v dispečerskem vmesniku.' }); }
  reset() { return this.mutate('/demo/reset', {}); }
}

// UI fixtures only. No routing, scheduling or optimization is performed here.
export class DemoDispatchGateway implements DispatchGateway {
  readonly isDemo = true;
  private state = createDemoState();
  private copy() { return structuredClone(this.state); }
  async getState() { return this.copy(); }
  async generateInitialPlan() { return this.copy(); }
  async restoreVehicle(id:string){
    const vehicle=this.state.vehicles.find(v=>v.id===id);if(!vehicle)throw new Error('Vozilo ne obstaja.');
    if(vehicle.status==='BROKEN'){vehicle.status='AVAILABLE';vehicle.available_at=this.state.simulated_time;this.state.state_revision++;this.state.incidents=this.state.incidents.map(i=>i.incident_type==='VEHICLE_BREAKDOWN'&&i.affected_vehicle_ids.includes(id)?{...i,status:'RESOLVED'}:i);}
    return this.copy();
  }
  async advanceTime(to:string) { this.state.simulated_time=to;this.state.state_revision++;return this.copy(); }
  async createIncident(input: IncidentInput) {
    if (input.incident_type !== 'NEW_TASK') throw new Error('Vzorčni scenarij podpira novo prednostno nalogo. Ostale dogodke pripravi backend.');
    if (this.state.tasks.some(t => t.id === 'N021')) return this.copy();
    this.state.tasks.push({ id:'N021', task_type:'PRIORITY_TRANSPORT', priority:'P1', status:'PENDING', origin:{lat:46.0618,lon:14.5016,name:'Celovška cesta · Tivoli'}, destination:{lat:46.0545,lon:14.5257,name:'UKC Ljubljana'}, passenger_count:1, required_equipment:['STRETCHER','OXYGEN'], earliest_pickup:demoTime('11:20'), latest_pickup:null });
    this.state.incidents.push({ id:'incident-1', incident_type:'NEW_TASK', title:'Nova prednostna naloga', description:'Simulirana nesreča na Celovški cesti z visoko prioriteto.', priority:'P1', status:'OPEN', occurred_at:this.state.simulated_time, location:{lat:46.0618,lon:14.5016,name:'Celovška cesta · Tivoli'}, affected_vehicle_ids:[], affected_task_ids:['N021'] });
    this.state.active_plan!.unassigned_task_ids = ['N021'];
    this.state.state_revision++;
    return this.copy();
  }
  async generateRecommendations(incidentId: string) {
    this.state.recommendations = createFixtureRecommendations(this.state, incidentId);
    this.state.incidents = this.state.incidents.map(i => i.id === incidentId ? {...i,status:'AWAITING_DECISION'} : i);
    return this.copy();
  }
  async accept(id: string) {
    const recommendation = this.state.recommendations.find(r => r.id === id);
    if (!recommendation || recommendation.status !== 'PROPOSED' || recommendation.base_plan_id !== this.state.active_plan?.id || recommendation.base_state_revision !== this.state.state_revision) throw new Error('Predlog ni več veljaven. Ponovno naložite stanje.');
    this.state.active_plan = {...structuredClone(recommendation.proposed_plan),status:'ACTIVE'};
    this.state.recommendations = this.state.recommendations.map(r => ({...r,status:r.id===id ? 'ACCEPTED' : 'STALE'}));
    this.state.incidents = this.state.incidents.map(i => i.id===recommendation.incident_id ? {...i,status:'RESOLVED',selected_recommendation_id:id,affected_vehicle_ids:[...new Set(recommendation.proposed_plan.assignments.filter(a=>a.task_id==='N021').map(a=>a.vehicle_id))]} : i);
    this.state.tasks = this.state.tasks.map(t => t.id==='N021' ? {...t,status:'ASSIGNED'} : t);
    this.state.decisions.push({ id:`decision-${this.state.decisions.length+1}`,recommendation_id:id,action:'ACCEPTED',reason:'Potrditev vzorčnega predloga v UI.',decided_at:this.state.simulated_time,actor:'Dispečer' });
    this.state.state_revision++;
    return this.copy();
  }
  async reject(id: string) {
    const recommendation = this.state.recommendations.find(r => r.id===id);
    if (recommendation) recommendation.status = 'REJECTED';
    this.state.decisions.push({id:`decision-${this.state.decisions.length+1}`,recommendation_id:id,action:'REJECTED',reason:'Predlog zavrnjen.',decided_at:this.state.simulated_time,actor:'Dispečer'});
    return this.copy();
  }
  async reset() { this.state = createDemoState(); return this.copy(); }
}
export function createGateway(config: RuntimeConfig): DispatchGateway {
  return config.dataSource === 'api' ? new HttpDispatchGateway(config.apiBaseUrl) : new DemoDispatchGateway();
}
