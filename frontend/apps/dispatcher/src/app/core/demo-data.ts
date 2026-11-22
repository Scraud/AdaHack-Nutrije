import type { Assignment, DispatchState, Recommendation } from '@rescueflow/contracts';

export const demoTime = (time: string) => `2026-11-21T${String(Number(time.slice(0, 2)) - 1).padStart(2, '0')}:${time.slice(3)}:00Z`;
const places = [
  { lat: 46.0560, lon: 14.5176, name: 'ZD Ljubljana – Center' },
  { lat: 46.0545, lon: 14.5257, name: 'UKC Ljubljana' },
  { lat: 46.0674, lon: 14.4922, name: 'ZD Šiška' },
  { lat: 46.0378, lon: 14.5059, name: 'ZD Vič – Rudnik' },
  { lat: 46.0729, lon: 14.5234, name: 'Bežigrad · Dunajska cesta' },
  { lat: 46.0522, lon: 14.4790, name: 'Rožna dolina' },
  { lat: 46.0643, lon: 14.5545, name: 'Moste · Zaloška cesta' },
  { lat: 46.0437, lon: 14.5380, name: 'Štepanjsko naselje' },
];
const slots = [
  [['08:10','09:00'],['09:30','10:15'],['10:55','11:45'],['13:00','13:55']],
  [['08:20','09:10'],['09:45','10:35'],['11:40','12:25'],['14:00','14:50']],
  [['08:00','08:55'],['09:20','10:10'],['11:05','12:10'],['13:15','14:10']],
  [['08:30','09:20'],['10:00','10:45'],['11:50','12:40'],['14:10','15:00']],
  [['08:10','08:50'],['09:35','10:25'],['11:00','11:50'],['13:10','14:00']],
];

export function createDemoState(): DispatchState {
  const now = demoTime('11:20');
  const tasks: DispatchState['tasks'] = [];
  const assignments: Assignment[] = [];
  for (let v = 0; v < 5; v++) for (let s = 0; s < 4; s++) {
    const id = `N${String(v * 4 + s + 1).padStart(3, '0')}`;
    const [start, end] = slots[v][s];
    const endMs = Date.parse(demoTime(end));
    const pickup = new Date(Date.parse(demoTime(start)) + 8 * 60_000).toISOString();
    const dropoff = new Date(endMs - 10 * 60_000).toISOString();
    const completed = endMs <= Date.parse(now);
    const active = !completed && Date.parse(demoTime(start)) <= Date.parse(now);
    tasks.push({ id, task_type: 'PLANNED_TRANSPORT', priority: s === 2 ? 'P2' : 'P3', status: completed ? 'COMPLETED' : active ? 'PICKED_UP' : 'ASSIGNED', origin: places[(v + s + 4) % places.length], destination: places[(v + s + 1) % 4], passenger_count: 1, required_equipment: v === 1 || v === 3 ? ['WHEELCHAIR'] : ['STRETCHER'], earliest_pickup: demoTime(start), preferred_arrival: dropoff, latest_arrival: new Date(endMs + 45 * 60_000).toISOString() });
    assignments.push({ id: `a-${id}`, task_id: id, vehicle_id: `V${v + 1}`, sequence_order: s, planned_departure: demoTime(start), planned_pickup: pickup, planned_dropoff: dropoff, planned_end: demoTime(end), status: completed ? 'COMPLETED' : active ? 'IN_PROGRESS' : 'PLANNED', is_locked: completed || active });
  }
  return {
    scenario_id: 'ui-fixture-ljubljana', state_revision: 1, simulated_time: now, horizon_start: demoTime('08:00'), horizon_end: demoTime('18:00'), mode: 'DEMO',
    facilities: places.slice(0, 4).map((p, i) => ({ ...p, id: `F${i+1}`, short_name: ['ZD Center', 'UKC Ljubljana', 'ZD Šiška', 'ZD Vič'][i], accepting: true })),
    vehicles: [
      { id:'V1', code:'V1', vehicle_type:'Reševalno vozilo', status:'TRANSPORTING', current_lat:46.0630, current_lon:14.5070, location_name:'Tivolska cesta', capacity:2, equipment:['STRETCHER','OXYGEN'], available_at:demoTime('11:45'), shift_end:demoTime('18:00') },
      { id:'V2', code:'V2', vehicle_type:'Prevoz z vozičkom', status:'AVAILABLE', current_lat:46.0702, current_lon:14.5365, location_name:'Bežigrad', capacity:2, equipment:['WHEELCHAIR'], available_at:now, shift_end:demoTime('18:00') },
      { id:'V3', code:'V3', vehicle_type:'Sanitetno vozilo', status:'TRANSPORTING', current_lat:46.0495, current_lon:14.5340, location_name:'Poljanska cesta', capacity:2, equipment:['STRETCHER','OXYGEN'], available_at:demoTime('12:10'), shift_end:demoTime('18:00') },
      { id:'V4', code:'V4', vehicle_type:'Prevoz z vozičkom', status:'AVAILABLE', current_lat:46.0465, current_lon:14.4880, location_name:'Rožna dolina', capacity:3, equipment:['WHEELCHAIR','STRETCHER'], available_at:now, shift_end:demoTime('18:00') },
      { id:'V5', code:'V5', vehicle_type:'Sanitetno vozilo', status:'EN_ROUTE', current_lat:46.0820, current_lon:14.5130, location_name:'Dunajska cesta', capacity:2, equipment:['STRETCHER','OXYGEN'], available_at:demoTime('11:50'), shift_end:demoTime('18:00') },
    ],
    tasks, active_plan: { id:'plan-1', version:1, status:'ACTIVE', assignments, unassigned_task_ids:[] }, incidents:[], recommendations:[], decisions:[],
  };
}

export function createFixtureRecommendations(state: DispatchState, incidentId: string): Recommendation[] {
  if (!state.active_plan) return [];
  if(!state.tasks.some(task=>task.id==='N021')){
    const plan=structuredClone(state.active_plan);
    plan.id=`fixture-plan-${state.state_revision}`;plan.version=(plan.version??0)+1;plan.status='DRAFT';
    return [{id:`fixture-rec-${state.state_revision}`,incident_id:incidentId,base_plan_id:state.active_plan.id,
      base_state_revision:state.state_revision,strategy:'MIN_CHANGES',title:'Ohrani obstoječe dodelitve',status:'PROPOSED',
      is_fixture:true,proposed_plan:plan,explanation:'Vzorčni predogled obstoječih nalog brez spremembe dodelitev.',
      trade_off:'Vzorčni prikaz ne izvaja optimizacije.',feasibility_reasons:['Za dejanski preračun uporabite povezavo z backendom.']}];
  }
  return ([['MIN_DELAY','Najmanj zamud','V1','11:50','12:25'], ['MIN_CHANGES','Najmanj sprememb','V5','11:55','12:35'], ['MAX_BUFFER','Več časovne rezerve','V3','12:15','12:55']] as const).map(([strategy,title,vehicle,start,end], i) => {
    const plan = structuredClone(state.active_plan!);
    plan.id = `fixture-plan-${i+2}`; plan.version = (plan.version ?? 0)+i+1; plan.status = 'DRAFT'; plan.unassigned_task_ids = [];
    plan.assignments.push({ id:`a-priority-${i}`, task_id:'N021', vehicle_id:vehicle, sequence_order:3, planned_departure:demoTime(start), planned_pickup:new Date(Date.parse(demoTime(start))+5*60_000).toISOString(), planned_dropoff:new Date(Date.parse(demoTime(end))-5*60_000).toISOString(), planned_end:demoTime(end), status:'PLANNED', is_locked:false });
    if (i === 0) {
      const moved = plan.assignments.find(a => a.task_id === 'N004')!;
      moved.vehicle_id = 'V3'; moved.sequence_order = 4;
      const follow = plan.assignments.find(a => a.task_id === 'N012')!;
      for (const key of ['planned_departure','planned_pickup','planned_dropoff','planned_end'] as const) follow[key] = new Date(Date.parse(follow[key])+45*60_000).toISOString();
      follow.sequence_order = 5;
    }
    return { id:`fixture-rec-${i+1}`, incident_id:incidentId, base_plan_id:state.active_plan!.id, base_state_revision:state.state_revision, strategy, title, status:'PROPOSED', is_fixture:true, proposed_plan:plan, explanation:`Vzorčni prikaz: ${vehicle} prevzame nalogo N021. ${i===0 ? 'Dve prihodnji dodelitvi se spremenita.' : 'Obstoječe dodelitve ostanejo na svojih mestih.'}`, trade_off:['Več sprememb obstoječega razporeda.','Kasnejši prihod nove prednostne naloge.','Poznejši prevzem; razpoložljivost mora potrditi optimizator.'][i], feasibility_reasons:['Ilustrativen razpored za preverjanje UI.', 'Izvedljivost mora potrditi backend validator.'] };
  });
}
