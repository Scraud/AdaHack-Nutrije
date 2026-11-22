import type { DispatchPlan, DispatchState, PlanDiff } from '../../contracts';
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
}
