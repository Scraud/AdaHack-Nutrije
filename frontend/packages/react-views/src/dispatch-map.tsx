import { useEffect, useRef } from 'react';
import L from 'leaflet';
import type { RoadMap, State, TrackingFrame } from '../../contracts';

const colors: Record<string, string> = {
  V1: '#1e5ec1', V2: '#00846e', V3: '#7d42bc', V4: '#a76a05', V5: '#ac397d',
};
const statuses: Record<string, string> = {
  WAITING: 'Čaka', TO_PICKUP: 'Na poti do pacienta', AT_PICKUP: 'Prevzem pacienta',
  TO_HOSPITAL: 'Na poti v ustanovo', AT_HOSPITAL: 'Pri ustanovi', STOPPED: 'Ustavljeno', GPS: 'Lokacija GPS',
};
const roadColors = ['#a3afbc', '#b6c0ca', '#c3ccd5', '#d5dde4'];
const roadWeights = [2.8, 2.1, 1.5, .85];

function icon(symbol: string, badge: string, kind: string, size: number, color?: string, eta?: HTMLElement) {
  const content = document.createElement('span');
  content.className = 'map-pin-content';
  if (color) content.style.setProperty('--pin-color', color);
  const graphic = document.createElement('span');
  graphic.textContent = symbol;
  graphic.setAttribute('aria-hidden', 'true');
  content.append(graphic);
  if (badge) {
    const label = document.createElement('b');
    label.textContent = badge;
    content.append(label);
  }
  if (eta) content.append(eta);
  return L.divIcon({ className: `map-pin ${kind}`, html: content,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

function tooltip(label: string) {
  const element = document.createElement('span');
  element.textContent = label;
  return element;
}

export function DispatchMap({ state, roads, frame, onSelect }: {
  state: State; roads: RoadMap | null; frame: TrackingFrame | null; onSelect: (id: string) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const layers = useRef<{
    leaf: L.Map;
    roads: L.LayerGroup; routes: L.LayerGroup; sites: L.LayerGroup; events: L.LayerGroup; tracking: L.LayerGroup;
    renderer: L.Canvas;
  } | null>(null);
  const vehicleMarkers = useRef(new Map<string, { marker: L.Marker; eta: HTMLSpanElement }>());
  const routeKey = useRef('');
  const siteKey = useRef('');
  const eventKey = useRef('');

  useEffect(() => {
    if (!element.current) return;
    const map = L.map(element.current, { scrollWheelZoom: false, minZoom: 11, maxZoom: 18 })
      .setView([46.060, 14.515], 12);
    map.attributionControl.setPrefix(false);
    map.attributionControl.addAttribution('&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>');
    for (const [name, index] of [['road-base', 300], ['vehicle-paths', 390], ['road-events', 410]] as const) {
      map.createPane(name).style.zIndex = String(index);
    }
    layers.current = {
      leaf: map,
      roads: L.layerGroup().addTo(map), routes: L.layerGroup().addTo(map), sites: L.layerGroup().addTo(map),
      events: L.layerGroup().addTo(map), tracking: L.layerGroup().addTo(map),
      renderer: L.canvas({ pane: 'road-base', padding: .35 }),
    };
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
    const resize = new ResizeObserver(() => map.invalidateSize());
    resize.observe(element.current);
    return () => {
      resize.disconnect();
      layers.current = null;
      vehicleMarkers.current.clear();
      routeKey.current = siteKey.current = eventKey.current = '';
      map.remove();
    };
  }, []);

  useEffect(() => {
    const map = layers.current;
    if (!map || !roads) return;
    map.roads.clearLayers();
    const roadLayer = (layer: RoadMap['layers'][number]) =>
      L.polyline(layer.paths, { renderer: map.renderer, interactive: false, smoothFactor: 1.2,
        color: roadColors[layer.rank], weight: roadWeights[layer.rank], opacity: .9 });
    const localRoads = roads.layers.filter(layer => layer.rank >= 3).map(roadLayer);
    for (const layer of [...roads.layers].reverse().filter(layer => layer.rank < 3)) {
      roadLayer(layer).addTo(map.roads);
    }
    const detail = () => {
      for (const layer of localRoads) {
        if (map.leaf.getZoom() >= 13) layer.addTo(map.roads).bringToBack();
        else map.roads.removeLayer(layer);
      }
    };
    detail();
    map.leaf.on('zoomend', detail);
    return () => { map.leaf.off('zoomend', detail); };
  }, [roads]);

  useEffect(() => {
    const map = layers.current;
    if (!map) return;
    const activeFrame = frame?.scenario_id === state.scenario_id ? frame : null;
    const vehicles = activeFrame?.vehicles ?? [];
    const shownTasks = new Set(vehicles.map(vehicle => vehicle.task_id));
    const pickups = state.tasks.filter(task => shownTasks.has(task.id) || !state.active_plan);
    const sites = JSON.stringify([state.scenario_id, state.facilities, pickups.map(task => task.id)]);
    if (sites !== siteKey.current) {
      siteKey.current = sites;
      map.sites.clearLayers();
      for (const site of state.facilities) {
        L.marker([site.location.lat, site.location.lon], { icon: icon('🏥', '', 'facility-pin', 48), title: site.name, alt: site.name })
          .bindTooltip(tooltip(site.name)).addTo(map.sites);
      }
      for (const task of pickups) {
        const title = `Prevzem ${task.id}`;
        L.marker([task.pickup.lat, task.pickup.lon], { icon: icon(task.id, '', 'pickup-pin', 32), title, alt: title })
          .bindTooltip(tooltip(title)).on('click', () => onSelect(task.id)).addTo(map.sites);
      }
    }

    const paths = JSON.stringify(vehicles.map(vehicle =>
      [vehicle.id, vehicle.task_id, vehicle.to_pickup, vehicle.to_hospital, vehicle.status === 'STOPPED']));
    if (paths !== routeKey.current) {
      routeKey.current = paths;
      map.routes.clearLayers();
      for (const vehicle of vehicles) {
        for (const [path, dotted] of [[vehicle.to_pickup, false], [vehicle.to_hospital, true]] as const) {
          if (!path || path.length < 2) continue;
          const style = { pane: 'vehicle-paths', opacity: vehicle.status === 'STOPPED' ? .45 : .95, lineCap: 'round' as const };
          const weight = dotted ? 4 : 3.5;
          L.polyline(path, { ...style, color: '#fff', weight: weight + 3, interactive: false,
            dashArray: dotted ? '2 8' : undefined }).addTo(map.routes);
          const line = L.polyline(path, { ...style, color: colors[vehicle.id], weight,
            dashArray: dotted ? '2 8' : undefined, className: dotted ? 'route-to-hospital' : 'route-to-pickup' });
          line.bindTooltip(tooltip(`${vehicle.id} · ${dotted ? 'Do ustanove' : 'Do pacienta'}`)).addTo(map.routes);
          if (vehicle.task_id) line.on('click', () => onSelect(vehicle.task_id!));
        }
      }
    }

    const events = JSON.stringify([roads?.timestamp, activeFrame?.incidents]);
    if (events !== eventKey.current) {
      eventKey.current = events;
      map.events.clearLayers();
      const closures = new Set(activeFrame?.incidents.filter(event => event.type === 'ROAD_CLOSURE').map(event => event.road_id));
      const seen = new Set<string>();
      for (const event of activeFrame?.incidents ?? []) {
        if (seen.has(event.road_id)) continue;
        seen.add(event.road_id);
        const segment = roads?.segments.find(road => road.id === event.road_id);
        if (!segment || segment.path.length < 2) continue;
        const closed = closures.has(event.road_id);
        const title = `${closed ? 'Zapora' : 'Zastoj'} · ${segment.name}`;
        L.polyline(segment.path, { pane: 'road-events', color: '#fff', weight: 9, interactive: false }).addTo(map.events);
        L.polyline(segment.path, { pane: 'road-events', color: closed ? '#920f28' : '#eb2432',
          weight: 6.5, className: closed ? 'road-closure' : 'road-traffic' }).bindTooltip(tooltip(title)).addTo(map.events);
        if (closed) {
          const center = (segment.path.length - 1) / 2;
          const a = segment.path[Math.floor(center)], b = segment.path[Math.ceil(center)];
          L.marker([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], {
            icon: icon('⛔', '', 'closure-pin', 26), title, alt: title, zIndexOffset: 700,
          }).bindTooltip(tooltip(title)).addTo(map.events);
        }
      }
    }

    const ids = new Set(vehicles.map(vehicle => vehicle.id));
    for (const [id, { marker }] of vehicleMarkers.current) {
      if (ids.has(id)) continue;
      map.tracking.removeLayer(marker);
      vehicleMarkers.current.delete(id);
    }
    for (const vehicle of vehicles) {
      let entry = vehicleMarkers.current.get(vehicle.id);
      if (!entry) {
        const eta = document.createElement('span');
        eta.className = 'map-eta';
        eta.hidden = true;
        const marker = L.marker(vehicle.location, { title: `Reševalno vozilo ${vehicle.id}`, alt: `Reševalno vozilo ${vehicle.id}`,
          icon: icon('🚑', vehicle.id, 'ambulance-pin', 38, colors[vehicle.id], eta), zIndexOffset: 400 }).addTo(map.tracking);
        entry = { marker, eta };
        vehicleMarkers.current.set(vehicle.id, entry);
      }
      const { marker, eta } = entry;
      const countdown = vehicle.eta
        ? `${vehicle.eta.destination === 'PICKUP' ? 'Do pacienta' : 'Do ustanove'} · ${Math.ceil(vehicle.eta.seconds / 60)} min`
        : '';
      if (eta.textContent !== countdown) eta.textContent = countdown;
      eta.hidden = !countdown;
      const age = vehicle.stale ? ' · zastarela lokacija' : '';
      const time = vehicle.recorded_at ? ' · ' + new Date(vehicle.recorded_at).toLocaleTimeString('sl-SI',
        { timeZone: 'Europe/Ljubljana' }) : '';
      const description = `${vehicle.id} · ${statuses[vehicle.status]}${age}${time}${countdown ? ' · ' + countdown : ''}`;
      const label = tooltip(description);
      marker.setLatLng(vehicle.location).setOpacity(vehicle.stale ? .55 : 1);
      marker.getElement()?.setAttribute('aria-label', description);
      if (marker.getTooltip()) marker.setTooltipContent(label);
      else marker.bindTooltip(label);
    }
  }, [state, roads, frame, onSelect]);

  return <div ref={element} className="dispatch-map" aria-label="Zemljevid cest in reševalnih vozil" />;
}
