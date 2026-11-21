import type { DispatchState, IncidentInput, RuntimeConfig } from '@rescueflow/contracts';
import { createDemoState, createFixtureRecommendations, demoTime } from './demo-data';

export interface DispatchGateway {
  readonly isDemo: boolean;
  getState(): Promise<DispatchState>;
  generateInitialPlan(): Promise<DispatchState>;
  createIncident(input: IncidentInput): Promise<DispatchState>;
  generateRecommendations(incidentId: string, state: DispatchState): Promise<DispatchState>;
  accept(id: string, state: DispatchState): Promise<DispatchState>;
  reject(id: string, state: DispatchState): Promise<DispatchState>;
  reset(): Promise<DispatchState>;
}

export class HttpDispatchGateway implements DispatchGateway {
  readonly isDemo = false;
  constructor(private readonly baseUrl: string) {}
  private async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      method: body === undefined ? 'GET' : 'POST', credentials:'same-origin',
      headers: { Accept:'application/json', ...(body === undefined ? {} : { 'Content-Type':'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      if (response.status === 409) throw new Error('Stanje se je spremenilo. Osvežite podatke in ponovno izračunajte predloge.');
      let detail = '';
      try { const json = await response.json(); if (typeof json.detail === 'string') detail = json.detail; } catch { /* Non-JSON upstream response. */ }
      throw new Error(detail || `Povezava z zaledjem ni uspela (HTTP ${response.status}).`);
    }
    return response.status === 204 ? undefined as T : response.json();
  }
  async getState() {
    const [state, recommendations] = await Promise.all([this.request<DispatchState>('/state'),this.request<DispatchState['recommendations']>('/recommendations')]);
    if (!Array.isArray(state.vehicles) || !Array.isArray(state.tasks) || !('active_plan' in state)) throw new Error('Odziv /api/state se ne ujema s pogodbo v packages/contracts.');
    if (!Array.isArray(recommendations)) throw new Error('Odziv /api/recommendations mora biti seznam predlogov s celotnimi plani.');
    return { ...state, incidents:state.incidents ?? [], recommendations, decisions:state.decisions ?? [] };
  }
  private async mutate(path: string, body: unknown) { await this.request(path, body); return this.getState(); }
  generateInitialPlan() { return this.mutate('/plans/generate', {}); }
  createIncident(input: IncidentInput) { return this.mutate('/incidents', input); }
  generateRecommendations(incidentId: string, state: DispatchState) { return this.mutate('/recommendations/generate', { incident_id:incidentId, base_plan_id:state.active_plan?.id, expected_state_revision:state.state_revision }); }
  accept(id: string, state: DispatchState) { return this.mutate(`/recommendations/${encodeURIComponent(id)}/accept`, { base_plan_id:state.active_plan?.id, expected_state_revision:state.state_revision }); }
  reject(id: string, state: DispatchState) { return this.mutate(`/recommendations/${encodeURIComponent(id)}/reject`, { reason:'Predlog zavrnjen v dispečerskem vmesniku.', expected_state_revision:state.state_revision }); }
  reset() { return this.mutate('/demo/reset', {}); }
}

// UI fixtures only. No routing, scheduling or optimization is performed here.
export class DemoDispatchGateway implements DispatchGateway {
  readonly isDemo = true;
  private state = createDemoState();
  private copy() { return structuredClone(this.state); }
  async getState() { return this.copy(); }
  async generateInitialPlan() { return this.copy(); }
  async createIncident(input: IncidentInput) {
    if (input.incident_type !== 'NEW_TASK') throw new Error('Vzorčni scenarij podpira novo prednostno nalogo. Ostale dogodke pripravi backend.');
    if (this.state.tasks.some(t => t.id === 'N021')) return this.copy();
    this.state.tasks.push({ id:'N021', task_type:'PRIORITY_TRANSPORT', priority:'P1', status:'PENDING', origin:{lat:46.0618,lon:14.5016,name:'Celovška cesta · Tivoli'}, destination:{lat:46.0545,lon:14.5257,name:'UKC Ljubljana'}, passenger_count:1, required_equipment:['STRETCHER','OXYGEN'], earliest_pickup:demoTime('11:20'), preferred_arrival:demoTime('12:20'), latest_arrival:demoTime('13:15') });
    this.state.incidents.push({ id:'incident-1', incident_type:'NEW_TASK', title:'Nova prednostna naloga', description:'Simulirana prometna nesreča na Celovški cesti. Zahtevani prevoz do UKC Ljubljana; prioriteto P1 in opremo je določil dispečer.', priority:'P1', status:'OPEN', occurred_at:this.state.simulated_time, location:{lat:46.0618,lon:14.5016,name:'Celovška cesta · Tivoli'}, affected_vehicle_ids:[], affected_task_ids:['N021'] });
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
