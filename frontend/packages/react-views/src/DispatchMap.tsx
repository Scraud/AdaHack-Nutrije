import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import type { DispatchViewProps } from './types';
import { colorFor, formatTime, statusLabel } from '../../contracts/plan-utils';

type MapStyle = 'calm' | 'streets';
type MapIconName = 'plus' | 'minus' | 'locate' | 'layers' | 'expand' | 'close' | 'pin' | 'clock' | 'eye';
const iconPaths: Record<MapIconName, string> = {
  plus:'M12 5v14M5 12h14', minus:'M5 12h14',
  locate:'M12 3v3m0 12v3M3 12h3m12 0h3M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z',
  layers:'m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5',
  expand:'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5', close:'m6 6 12 12M6 18 18 6',
  pin:'M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0Zm-8-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  clock:'M12 8v4l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
  eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
};
function MapIcon({name}: {name:MapIconName}) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[name]}/></svg>;
}
const ambulance = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"><path d="M3 6h12v12H3zM15 10h4l3 4v4h-7M6 18a2 2 0 1 0 4 0M16 18a2 2 0 1 0 4 0M9 9v6M6 12h6"/></svg>';
const initialBounds: L.LatLngBoundsExpression = [[46.033,14.472],[46.085,14.562]];
const escapeHtml = (value: string) => value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const unavailable = (status: string) => status==='BROKEN' || status==='UNAVAILABLE';

function vehiclePoints(props: DispatchViewProps, vehicleId: string): L.LatLngTuple[] {
  const vehicle=props.state.vehicles.find(v=>v.id===vehicleId);
  if(!vehicle) return [];
  const route=props.plan?.routes?.find(r=>r.vehicle_id===vehicleId);
  if(route && route.coordinates.length>1) return [[vehicle.current_lat,vehicle.current_lon],...route.coordinates.map(([lon,lat]):L.LatLngTuple=>[lat,lon])];
  const points:L.LatLngTuple[]=[[vehicle.current_lat,vehicle.current_lon]];
  const upcoming=props.plan?.assignments.filter(a=>a.vehicle_id===vehicleId && Date.parse(a.planned_end)>Date.parse(props.state.simulated_time)).sort((a,b)=>a.sequence_order-b.sequence_order) ?? [];
  for(const assignment of upcoming) {
    const task=props.state.tasks.find(t=>t.id===assignment.task_id);
    if(task) points.push([task.origin.lat,task.origin.lon],[task.destination.lat,task.destination.lon]);
  }
  return points;
}

export function DispatchMap(props: DispatchViewProps) {
  const container=useRef<HTMLDivElement>(null);
  const expandButton=useRef<HTMLButtonElement>(null);
  const map=useRef<L.Map|null>(null);
  const features=useRef<L.LayerGroup|null>(null);
  const [mapReady,setMapReady]=useState(false);
  const [tileState,setTileState]=useState<'loading'|'ready'|'offline'>('loading');
  const [mapStyle,setMapStyle]=useState<MapStyle>('calm');
  const [showFacilities,setShowFacilities]=useState(true);
  const [showRoutes,setShowRoutes]=useState(true);
  const [layersOpen,setLayersOpen]=useState(false);
  const [fullScreen,setFullScreen]=useState(false);
  const selectedVehicle=props.state.vehicles.find(v=>v.id===props.selectedVehicleId);
  const isRoadRoute=(vehicleId:string)=>props.plan?.routes?.some(r=>r.vehicle_id===vehicleId && r.source==='OSRM' && r.coordinates.length>1) ?? false;
  const hasRoadRoutes=props.state.vehicles.some(v=>isRoadRoute(v.id));
  const hasApproximateRoutes=props.state.vehicles.some(v=>vehiclePoints(props,v.id).length>1 && !isRoadRoute(v.id));
  const animate=!window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(()=>{
    if(!container.current) return;
    const instance=L.map(container.current,{zoomControl:false,scrollWheelZoom:false,attributionControl:true,zoomSnap:0.5,zoomDelta:0.5}).fitBounds(initialBounds,{padding:[45,45]});
    map.current=instance;
    L.imageOverlay('/map-fallback.svg',[[46.018,14.445],[46.105,14.59]],{interactive:false}).addTo(instance);
    for(const [name,zIndex] of [['dispatchRoutes',410],['dispatchFacilities',430],['dispatchVehicles',450],['dispatchIncidents',470]] as const) instance.createPane(name).style.zIndex=String(zIndex);
    const tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>'});
    let loadedTiles=0,failedTiles=0;
    tiles.on('loading',()=>{loadedTiles=0;failedTiles=0;});
    tiles.on('tileload',()=>{loadedTiles++;setTileState('ready');});
    tiles.on('tileerror',()=>{failedTiles++;});
    tiles.on('load',()=>{if(failedTiles && !loadedTiles)setTileState('offline');});
    tiles.addTo(instance);
    features.current=L.layerGroup().addTo(instance);
    const observer=new ResizeObserver(()=>instance.invalidateSize());observer.observe(container.current);
    setMapReady(true);
    return ()=>{observer.disconnect();tiles.off();instance.remove();map.current=null;features.current=null;};
  },[]);

  useEffect(()=>{
    const group=features.current;if(!group || !mapReady) return;
    group.clearLayers();
    const {state,plan,selectedVehicleId,diff}=props;
    const orderedVehicles=[...state.vehicles].sort((a,b)=>Number(a.id===selectedVehicleId)-Number(b.id===selectedVehicleId));
    if(showRoutes) for(const vehicle of orderedVehicles) {
      const suppliedRoute=plan?.routes?.find(r=>r.vehicle_id===vehicle.id);
      const hasGeometry=!!suppliedRoute && suppliedRoute.coordinates.length>1;
      const coords:L.LatLngTuple[]=hasGeometry ? suppliedRoute.coordinates.map(([lon,lat])=>[lat,lon]) : vehiclePoints(props,vehicle.id);
      if(coords.length<2) continue;
      const selected=selectedVehicleId===vehicle.id,changed=diff.vehicle_ids.has(vehicle.id),dimmed=!!selectedVehicleId && !selected;
      const weight=selected?4.5:changed?3.5:2.5;
      L.polyline(coords,{pane:'dispatchRoutes',color:'#ffffff',weight:weight+3.5,opacity:dimmed?0.2:0.88,interactive:false}).addTo(group);
      L.polyline(coords,{pane:'dispatchRoutes',color:colorFor(vehicle.id),weight,opacity:dimmed?0.15:selected?0.95:0.6,dashArray:hasGeometry && suppliedRoute.source==='OSRM'?undefined:'5 8',lineCap:'round',lineJoin:'round',className:changed?'rf-route-changed':'rf-route'})
        .addTo(group).on('click',()=>props.onSelectVehicle(vehicle.id));
      if(selected) for(const assignment of plan?.assignments.filter(a=>a.vehicle_id===vehicle.id && Date.parse(a.planned_end)>Date.parse(state.simulated_time)) ?? []) {
        const task=state.tasks.find(t=>t.id===assignment.task_id);if(!task)continue;
        L.circleMarker([task.origin.lat,task.origin.lon],{pane:'dispatchRoutes',radius:5,weight:2.5,color:colorFor(vehicle.id),fillColor:'white',fillOpacity:1}).addTo(group)
          .bindTooltip(`${escapeHtml(task.id)} · ${escapeHtml(task.origin.name)}`,{className:'rf-map-tooltip',direction:'top'})
          .on('click',()=>props.onSelectTask(task.id));
      }
    }
    if(showFacilities) for(const facility of state.facilities) {
      L.marker([facility.lat,facility.lon],{pane:'dispatchFacilities',icon:L.divIcon({className:'rf-facility-marker',html:`<span class="rf-facility-symbol">+</span><span class="rf-facility-name">${escapeHtml(facility.short_name)}</span>`,iconSize:[28,28],iconAnchor:[14,14]}),title:facility.name})
        .addTo(group).bindTooltip(escapeHtml(facility.name),{className:'rf-map-tooltip',direction:'top',offset:[0,-15]});
    }
    for(const vehicle of orderedVehicles) {
      const selected=selectedVehicleId===vehicle.id;
      const status=unavailable(vehicle.status)?'unavailable':vehicle.status==='AVAILABLE'?'available':'moving';
      const marker=L.marker([vehicle.current_lat,vehicle.current_lon],{
        pane:'dispatchVehicles',icon:L.divIcon({className:`rf-vehicle-marker ${selected?'is-selected':''} ${selectedVehicleId&&!selected?'is-muted':''} ${diff.vehicle_ids.has(vehicle.id)?'is-changed':''}`,html:`<div class="rf-vehicle-pin" style="--marker-color:${colorFor(vehicle.id)}"><span class="rf-vehicle-glyph">${ambulance}</span><b>${escapeHtml(vehicle.code)}</b><i class="rf-marker-status ${status}"></i></div>`,iconSize:[82,40],iconAnchor:[41,22]}),
        title:`${vehicle.code} · ${statusLabel(vehicle.status)}`,zIndexOffset:selected?1000:500,
      });
      marker.addTo(group).on('click',()=>props.onSelectVehicle(vehicle.id));
      const tooltip=document.createElement('div');tooltip.className='rf-vehicle-tooltip';
      const title=document.createElement('strong');title.textContent=`${vehicle.code} · ${vehicle.vehicle_type}`;
      const detail=document.createElement('span');detail.textContent=`${statusLabel(vehicle.status)} · ${vehicle.location_name}`;
      const availability=document.createElement('small');availability.textContent=`Prosto ob ${formatTime(vehicle.available_at)}`;
      tooltip.append(title,detail,availability);
      marker.bindTooltip(tooltip,{className:'rf-map-tooltip',direction:'top',offset:[0,-23]});
    }
    for(const incident of state.incidents.filter(i=>i.status!=='RESOLVED')) {
      L.marker([incident.location.lat,incident.location.lon],{pane:'dispatchIncidents',icon:L.divIcon({className:'rf-incident-marker',html:'<span>!</span>',iconSize:[34,34],iconAnchor:[17,17]}),title:incident.title,zIndexOffset:1100})
        .addTo(group).bindTooltip(escapeHtml(`${incident.title} · ${incident.priority}`),{className:'rf-map-tooltip',direction:'top',offset:[0,-20]});
    }
  },[props,showFacilities,showRoutes,mapReady]);

  useEffect(()=>{
    if(!props.selectedVehicleId || !map.current || !mapReady) return;
    const points=vehiclePoints(props,props.selectedVehicleId);
    if(points.length) map.current.fitBounds(L.latLngBounds(points),{padding:[55,65],maxZoom:14.5,animate,duration:0.25});
    // Preview updates layers without moving the viewport; only selection changes recenter it.
  },[props.selectedVehicleId,mapReady]);

  useEffect(()=>{
    if(!fullScreen && !layersOpen) return;
    const close=(event:KeyboardEvent)=>{if(event.key==='Escape'){setLayersOpen(false);if(fullScreen){setFullScreen(false);expandButton.current?.focus();}}};
    document.addEventListener('keydown',close);return ()=>document.removeEventListener('keydown',close);
  },[fullScreen,layersOpen]);
  useEffect(()=>{
    if(!fullScreen)return;
    const previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';
    return ()=>{document.body.style.overflow=previousOverflow;};
  },[fullScreen]);

  function fitFleet() {
    const points:L.LatLngTuple[]=[...props.state.vehicles.flatMap(v=>vehiclePoints(props,v.id)),...props.state.facilities.map((f):L.LatLngTuple=>[f.lat,f.lon])];
    map.current?.fitBounds(points.length?L.latLngBounds(points):initialBounds,{padding:[50,65],maxZoom:14,animate,duration:0.25});
  }

  return <div className={`rescueflow-map rf-map-${mapStyle} ${fullScreen?'rf-map-expanded':''}`}>
    <div ref={container} className="rf-map-canvas" aria-label="Zemljevid vozil in ustanov v Ljubljani"/>
    <div className="rf-map-topbar"><div className="rf-map-location"><span className="rf-location-icon"><MapIcon name="pin"/></span><div><b>Ljubljana</b><span>{props.state.vehicles.length} vozil na zemljevidu</span></div></div>{props.isPreview&&<span className="rf-map-preview"><MapIcon name="eye"/>Predogled</span>}</div>
    <div className="rf-map-controls" role="group" aria-label="Upravljanje zemljevida">
      <button type="button" aria-label="Povečaj zemljevid" title="Povečaj" onClick={()=>map.current?.zoomIn()}><MapIcon name="plus"/></button><button type="button" aria-label="Pomanjšaj zemljevid" title="Pomanjšaj" onClick={()=>map.current?.zoomOut()}><MapIcon name="minus"/></button><span/><button type="button" aria-label="Prikaži vso floto" title="Prikaži vso floto" onClick={fitFleet}><MapIcon name="locate"/></button>
    </div>
    {selectedVehicle&&<div className="rf-map-selection" style={{'--marker-color':colorFor(selectedVehicle.id)} as React.CSSProperties}>
      <div className="rf-selection-heading"><span className="rf-selection-id">{selectedVehicle.code}</span><b>{selectedVehicle.vehicle_type}</b><button type="button" aria-label="Prekliči izbor vozila" onClick={()=>props.onSelectVehicle(selectedVehicle.id)}><MapIcon name="close"/></button></div>
      <div className="rf-selection-status"><i className={`rf-marker-status ${unavailable(selectedVehicle.status)?'unavailable':selectedVehicle.status==='AVAILABLE'?'available':'moving'}`}/>{statusLabel(selectedVehicle.status)}</div>
      <p><MapIcon name="pin"/>{selectedVehicle.location_name}</p><p><MapIcon name="clock"/>Prosto ob {formatTime(selectedVehicle.available_at)}</p>{props.diff.vehicle_ids.has(selectedVehicle.id)&&<span className="rf-selection-change">Spremenjeno v predogledu</span>}
    </div>}
    <div className="rf-map-bottom-controls"><button type="button" aria-label="Plasti in izgled zemljevida" title="Plasti in izgled" aria-expanded={layersOpen} aria-controls="dispatch-map-layers" className={layersOpen?'is-active':''} onClick={()=>setLayersOpen(!layersOpen)}><MapIcon name="layers"/></button><button ref={expandButton} type="button" aria-label={fullScreen?'Zapri povečani zemljevid':'Povečaj prikaz zemljevida'} title={fullScreen?'Zapri (Esc)':'Povečaj prikaz'} aria-pressed={fullScreen} onClick={()=>setFullScreen(!fullScreen)}><MapIcon name={fullScreen?'close':'expand'}/></button></div>
    {layersOpen&&<div id="dispatch-map-layers" className="rf-map-layers"><div className="rf-layers-heading"><b>Izgled zemljevida</b><button type="button" aria-label="Zapri nastavitve zemljevida" onClick={()=>setLayersOpen(false)}><MapIcon name="close"/></button></div>
      <div className="rf-map-style-picker" role="group" aria-label="Barvni slog podlage"><button type="button" aria-pressed={mapStyle==='calm'} className={mapStyle==='calm'?'is-active':''} onClick={()=>setMapStyle('calm')}><span className="rf-style-swatch calm"/>Umirjen</button><button type="button" aria-pressed={mapStyle==='streets'} className={mapStyle==='streets'?'is-active':''} onClick={()=>setMapStyle('streets')}><span className="rf-style-swatch streets"/>Ulični</button></div>
      <label><input type="checkbox" checked={showFacilities} onChange={e=>setShowFacilities(e.target.checked)}/>Zdravstvene ustanove</label><label><input type="checkbox" checked={showRoutes} onChange={e=>setShowRoutes(e.target.checked)}/>Poti vozil</label>
    </div>}
    <div className="rf-map-legend"><div className="rf-legend-vehicles" aria-label="Izbor vozila na zemljevidu">{props.state.vehicles.map(v=><button key={v.id} type="button" className={props.selectedVehicleId===v.id?'is-selected':''} aria-pressed={props.selectedVehicleId===v.id} title={`Izberi vozilo ${v.code}`} onClick={()=>props.onSelectVehicle(v.id)}><i style={{background:colorFor(v.id)}}/>{v.code}</button>)}</div><div className="rf-legend-description">{showRoutes&&hasRoadRoutes&&<span><i className="rf-road-line"/>Cestne poti · OSRM</span>}{showRoutes&&hasApproximateRoutes&&<span><i className="rf-approximate-line"/>Približne povezave, ne cestne poti</span>}{showFacilities&&<span><b>+</b>Ustanove</span>}</div></div>
    {tileState==='offline'&&<span className="rf-map-offline" role="status">Brez povezave · shematska podlaga</span>}
  </div>;
}
