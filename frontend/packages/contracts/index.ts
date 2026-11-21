export type Equipment = 'STRETCHER' | 'WHEELCHAIR' | 'OXYGEN';
export type VehicleStatus = 'AVAILABLE' | 'EN_ROUTE' | 'TRANSPORTING' | 'UNAVAILABLE' | 'BROKEN';
export interface Location { lat: number; lon: number; name: string }
export interface Vehicle {
  id: string; code: string; vehicle_type: string; status: VehicleStatus;
  current_lat: number; current_lon: number; location_name: string;
  capacity: number; equipment: Equipment[]; available_at: string; shift_end: string;
}
export interface Facility extends Location { id: string; short_name: string; accepting: boolean }
export interface TransportTask {
  id: string; task_type: 'PLANNED_TRANSPORT' | 'PRIORITY_TRANSPORT';
  priority: 'P1' | 'P2' | 'P3'; status: string; origin: Location; destination: Location;
  passenger_count: number; required_equipment: Equipment[];
  earliest_pickup: string; preferred_arrival: string; latest_arrival: string;
}
export interface Assignment {
  id: string; task_id: string; vehicle_id: string; sequence_order: number;
  planned_departure: string; planned_pickup: string; planned_dropoff: string; planned_end: string;
  status: 'PLANNED' | 'IN_PROGRESS' | 'COMPLETED' | 'SUPERSEDED'; is_locked: boolean;
}
export interface VehicleRoute {
  vehicle_id: string;
  coordinates: [number, number][]; // GeoJSON order: [longitude, latitude].
  source: 'OSRM' | 'APPROXIMATE';
}
export interface DispatchPlan {
  id: string; version: number; status: 'ACTIVE' | 'DRAFT' | 'SUPERSEDED';
  assignments: Assignment[]; unassigned_task_ids: string[]; routes?: VehicleRoute[];
  metrics?: { remaining_buffer_minutes?: number };
}
export type IncidentType = 'NEW_TASK' | 'VEHICLE_BREAKDOWN' | 'TRAFFIC_DELAY' | 'ROAD_CLOSURE' | 'VEHICLE_UNAVAILABLE';
export interface Incident {
  id: string; incident_type: IncidentType; title: string; description: string;
  priority: 'P1' | 'P2' | 'P3'; status: 'OPEN' | 'AWAITING_DECISION' | 'RESOLVED';
  occurred_at: string; location: Location; affected_vehicle_ids: string[]; affected_task_ids: string[];
  selected_recommendation_id?: string;
}
export interface Recommendation {
  id: string; incident_id: string; base_plan_id: string; base_state_revision: number;
  strategy: 'MIN_DELAY' | 'MIN_CHANGES' | 'MAX_BUFFER'; status: 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'STALE';
  title: string; explanation: string; trade_off: string; feasibility_reasons: string[];
  proposed_plan: DispatchPlan;
  solver_status?: 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'UNKNOWN' | 'MODEL_INVALID';
  is_fixture?: boolean;
}
export interface Decision {
  id: string; recommendation_id: string; action: 'ACCEPTED' | 'REJECTED';
  reason: string; decided_at: string; actor: string;
}
export interface DispatchState {
  scenario_id: string; state_revision: number; simulated_time: string;
  horizon_start: string; horizon_end: string; mode: 'DEMO' | 'LIVE';
  vehicles: Vehicle[]; facilities: Facility[]; tasks: TransportTask[];
  active_plan: DispatchPlan | null; incidents: Incident[];
  recommendations: Recommendation[]; decisions: Decision[];
}
export interface IncidentInput {
  incident_type: IncidentType; affected_vehicle_id?: string; priority: 'P1' | 'P2' | 'P3';
  scenario: 'priority_transport_1120' | 'vehicle_breakdown' | 'traffic_delay';
}
export interface RuntimeConfig { dataSource: 'demo' | 'api'; apiBaseUrl: string }
export interface PlanDiff { added: Set<string>; changed: Set<string>; removed: Set<string>; vehicle_ids: Set<string> }
