import type { DispatchPlan, DispatchState, Location, PlanDiff, TrackingFrame, RoadMap, RoadSegment } from '../../contracts';
export interface DispatchViewProps {
  state: DispatchState;
  plan: DispatchPlan | null;
  basePlan: DispatchPlan | null;
  diff: PlanDiff;
  selectedVehicleId: string | null;
  selectedTaskId?: string | null;
  isPreview: boolean;
  onSelectVehicle: (id: string) => void;
  onSelectTask: (id: string) => void;
  tracking?: TrackingFrame | null;
  roads?: RoadMap | null;
  pickingRoad?: boolean;
  roadPreview?: RoadSegment | null;
  pickingLocation?: boolean;
  locationPreview?: Location | null;
  onPickRoad?: (location: [number, number]) => void;
}
