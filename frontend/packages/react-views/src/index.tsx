import { createRoot, type Root } from 'react-dom/client';
import { DispatchMap } from './DispatchMap';
import { VehicleTimeline } from './VehicleTimeline';
import type { DispatchViewProps } from './types';
export type { DispatchViewProps } from './types';
export type ViewKind = 'map' | 'timeline';
export function mount(element: HTMLElement, kind: ViewKind, props: DispatchViewProps) {
  const root: Root=createRoot(element);
  const update=(next:DispatchViewProps)=>root.render(kind==='map'?<DispatchMap {...next}/>:<VehicleTimeline {...next}/>);
  update(props);
  return {update,unmount:()=>root.unmount()};
}
