import type { components } from './api';
export type TrackingFrame = components['schemas']['TrackingFrame'];
export type Playback = components['schemas']['Playback'];
export type RoadMap = components['schemas']['RoadMap'];
export type RoadSegment = components['schemas']['RoadSegment'];
export type Priority = components['schemas']['NewTask']['priority'];
export const PRIORITY_LABELS: Record<Priority, string> = { P1: 'Visoka', P2: 'Srednja', P3: 'Nizka' };
export type SourceStatus = components['schemas']['SourceStatus'];
export type RecommendationInsight = components['schemas']['Explanation'];
export type BackendState = components['schemas']['State'];
export type ScheduledTaskInput = components['schemas']['CreateScheduledTask'];
export type Equipment = 'STRETCHER' | 'WHEELCHAIR' | 'OXYGEN';
export type VehicleTaskType = 'PLANNED_TRANSPORT' | 'PRIORITY_TRANSPORT' | 'EQUIPMENT_DELIVERY';
export interface VehicleSettings { capacity: number; equipment: Equipment[]; task_types: VehicleTaskType[] }
export interface NewVehicleInput extends VehicleSettings { location: { lat: number; lon: number } }
export type VehicleStatus = 'AVAILABLE' | 'EN_ROUTE' | 'TRANSPORTING' | 'SERVICE' | 'UNAVAILABLE' | 'BROKEN';
export interface Location { lat: number; lon: number; name: string }
export interface Vehicle {
  id: string; code: string; vehicle_type: string; status: VehicleStatus;
  current_lat: number; current_lon: number; location_name: string;
  capacity: number; equipment: Equipment[]; task_types: VehicleTaskType[]; available_at: string | null; shift_end: string | null;
}
export interface Facility extends Location { id: string; short_name: string; accepting: boolean }
export interface TransportTask {
  id: string; task_type: 'PLANNED_TRANSPORT' | 'PRIORITY_TRANSPORT' | 'EQUIPMENT_DELIVERY';
  priority: Priority; status: string; origin: Location; destination: Location;
  passenger_count: number; required_equipment: Equipment[];
  // earliest_pickup is the desired pickup; latest_pickup follows from priority (null for red = ASAP).
  earliest_pickup: string; latest_pickup: string | null;
  actual_pickup?: string | null; actual_arrival?: string | null;
  cleaning_minutes?: number;
  planning_status?: 'FUTURE';
}
export interface Assignment {
  id: string; task_id: string; vehicle_id: string; sequence_order: number;
  planned_departure: string; planned_pickup: string; planned_dropoff: string; planned_end: string;
  status: 'PLANNED' | 'IN_PROGRESS' | 'COMPLETED' | 'SUPERSEDED' | 'FAILED'; is_locked: boolean;
}
export interface VehicleRoute {
  vehicle_id: string;
  coordinates: [number, number][]; // GeoJSON order: [longitude, latitude].
  source: 'OSRM' | 'APPROXIMATE';
}
export interface DispatchPlan {
  id: string; version: number | null; status: 'ACTIVE' | 'DRAFT' | 'SUPERSEDED';
  assignments: Assignment[]; unassigned_task_ids: string[]; routes?: VehicleRoute[];
  metrics?: { remaining_buffer_minutes?: number; delay_minutes?: number; at_risk_tasks?: number; travel_minutes?: number; solve_ms?: number };
  blocking_issues?: string[]; unassigned_reasons?: Record<string,string>;
  released_task_ids?: string[];
}
export type IncidentType = 'NEW_TASK' | 'VEHICLE_BREAKDOWN' | 'TRAFFIC_DELAY' | 'ROAD_CLOSURE' | 'VEHICLE_UNAVAILABLE' | 'WEATHER_DELAY' | 'FACILITY_CAPACITY_CHANGE' | 'FLEET_CHANGE';
// Same traffic simulation parameters as main's IncidentCenter.traffic().
export const ROAD_EVENT_DEFAULTS = {duration_minutes:90,delay_multiplier:2.3} as const;
export interface Incident {
  id: string; incident_type: IncidentType; title: string; description: string;
  priority: Priority; status: 'OPEN' | 'AWAITING_DECISION' | 'RESOLVED';
  occurred_at: string; location: Location; affected_vehicle_ids: string[]; affected_task_ids: string[];
  selected_recommendation_id?: string;
  has_location?: boolean; duration_minutes?: number; delay_multiplier?: number;
}
export interface Recommendation {
  id: string; incident_id: string; base_plan_id: string; base_state_revision: number;
  strategy: 'MIN_DELAY' | 'MIN_CHANGES' | 'MAX_BUFFER'; status: 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'STALE';
  title: string; explanation: string; trade_off: string; feasibility_reasons: string[];
  proposed_plan: DispatchPlan;
  solver_status?: 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'UNKNOWN' | 'MODEL_INVALID';
  is_fixture?: boolean;
  incident_ids?: string[];
}
export interface Decision {
  id: string; recommendation_id: string; action: 'ACCEPTED' | 'REJECTED';
  reason: string; decided_at: string; actor: string;
}
export interface DispatchState {
  scenario_id: string; state_revision: number; simulated_time: string;
  horizon_start: string; horizon_end: string; mode: 'DEMO' | 'LIVE';
  vehicles: Vehicle[]; facilities: Facility[]; tasks: TransportTask[];
  future_tasks?: TransportTask[];
  active_plan: DispatchPlan | null; incidents: Incident[];
  recommendations: Recommendation[]; decisions: Decision[];
  affected_task_ids?: string[]; issues?: {task_id:string;vehicle_id?:string|null;code:string;message:string}[];
  history?: {id:string;version:number|null;status:string;created_at:string;strategy:string}[];
  backend?: BackendState;
}
export interface IncidentInput {
  incident_type: IncidentType; affected_vehicle_id?: string; priority: Priority;
  scenario?: 'priority_transport_1120' | 'vehicle_breakdown' | 'traffic_delay';
  description?: string; duration_minutes?: number; delay_multiplier?: number; location?: Location; road_id?: string;
  task?: {pickup:Location;passenger_count:number;equipment:Equipment[];earliest_pickup?:string};
}
export interface RuntimeConfig { dataSource: 'demo' | 'api'; apiBaseUrl: string }
export interface PlanDiff { added: Set<string>; changed: Set<string>; removed: Set<string>; vehicle_ids: Set<string> }
