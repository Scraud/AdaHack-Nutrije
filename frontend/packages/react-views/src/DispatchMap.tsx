import { DispatchMap as MainDispatchMap } from './main-dispatch-map';
import type { DispatchViewProps } from './types';

// Keep main's map intact; adapt only the surrounding application's view model.
export function DispatchMap(props: DispatchViewProps) {
  const state=props.state.backend;
  if(!state)return <div className="main-dispatch-map"><p className="main-map-message">Zemljevid potrebuje povezavo z backendom.</p></div>;
  return <div className="main-dispatch-map">
    <MainDispatchMap state={state} roads={props.roads??null} frame={props.tracking??null}
      onSelect={props.onSelectTask} pickingRoad={!!props.pickingRoad}
      roadPreview={props.roadPreview??null} onPick={props.onPickRoad??(()=>undefined)}/>
    <div className="map-legend"><span><i aria-hidden="true">🚑</i> Reševalno vozilo</span><span><i aria-hidden="true">🏥</i> Ustanova</span><span><i className="legend-line"/> Do pacienta</span><span><i className="legend-line dotted"/> Do ustanove</span><span><i className="legend-line traffic"/> Zastoj</span><span><i aria-hidden="true">⛔</i> Zapora</span></div>
    {props.pickingRoad&&<p className="main-map-message" role="status">Kliknite cestni odsek na zemljevidu.</p>}
    {props.isPreview&&!props.tracking&&<p className="main-map-message" role="status">Cestni predogled še ni na voljo.</p>}
  </div>;
}
