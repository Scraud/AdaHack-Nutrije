import { useEffect, useState } from 'react';
import type { RoadMap } from '../../contracts';
import { DispatchMap as MainDispatchMap } from './main-dispatch-map';
import type { DispatchViewProps } from './types';

// Keep main's map intact; adapt only the surrounding application's view model.
export function DispatchMap(props: DispatchViewProps) {
  const [regionalRoads, setRegionalRoads] = useState<RoadMap | null>(null);
  useEffect(() => {
    if (!props.isHomeMap) return;
    const request = new AbortController();
    async function loadRegionalRoads() {
      try {
        const url = new URL('maps/ljubljana-region.json.gz', document.baseURI);
        const response = await fetch(url, { signal: request.signal });
        if (!response.ok || !response.body) return;
        const roads = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
        if (!request.signal.aborted) setRegionalRoads(roads);
      } catch {
        // The local operational roads remain available if the regional asset cannot load.
      }
    }
    void loadRegionalRoads();
    return () => request.abort();
  }, [props.isHomeMap]);

  const state=props.state.backend;
  if(!state)return <div className="main-dispatch-map"><p className="main-map-message">Zemljevid potrebuje povezavo z backendom.</p></div>;
  const roads = (props.isHomeMap && !props.pickingRoad ? regionalRoads : null) ?? props.roads ?? null;
  return <div className="main-dispatch-map">
    <MainDispatchMap state={state} roads={roads} frame={props.tracking??null}
      planTaskIds={props.plan?.assignments.map(assignment=>assignment.task_id)??[]}
      onSelect={props.onSelectTask} pickingRoad={!!props.pickingRoad}
      roadPreview={props.roadPreview??null} onPick={props.onPickRoad??(()=>undefined)}
      pickingLocation={!!props.pickingLocation} locationPreview={props.locationPreview??null}/>
    {props.pickingLocation?<p className="main-map-message">Kliknite lokacijo prevzema na zemljevidu.</p>:
      <div className="map-legend"><span><i aria-hidden="true">🚑</i> Reševalno vozilo</span><span><i aria-hidden="true">🏥</i> Ustanova</span><span><i className="legend-line"/> Do pacienta</span><span><i className="legend-line dotted"/> Do ustanove</span><span><i className="legend-line traffic"/> Zastoj</span><span><i aria-hidden="true">⛔</i> Zapora</span></div>}
    {props.pickingRoad&&<p className="main-map-message" role="status">Kliknite cestni odsek na zemljevidu.</p>}
    {props.isPreview&&!props.tracking&&<p className="main-map-message" role="status">Cestni predogled še ni na voljo.</p>}
  </div>;
}
