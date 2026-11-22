import { useEffect, useRef } from 'react';
import L from 'leaflet';
import type { RoadMap, RoadSegment, State, TrackingFrame } from '../../contracts';
import { measure, pointAt, progress, remaining } from './route-motion';
import type { Coordinate, Leg } from './route-motion';

const colors: Record<string, string> = {
  V1: '#1e5ec1', V2: '#00846e', V3: '#7d42bc', V4: '#a76a05', V5: '#ac397d',
};
const statuses: Record<string, string> = {
  WAITING: 'Čaka', TO_PICKUP: 'Na poti do pacienta', AT_PICKUP: 'Prevzem pacienta',
  TO_HOSPITAL: 'Na poti v ustanovo', AT_HOSPITAL: 'Pri ustanovi', STOPPED: 'Ustavljeno', GPS: 'Lokacija GPS',
};
const roadColors = ['#a3afbc', '#b6c0ca', '#c3ccd5', '#d5dde4'];
const roadWeights = [2.8, 2.1, 1.5, .85];

type RouteLines = { casing: L.Polyline; color: L.Polyline };
type VehicleRoutes = { approach: RouteLines | null; delivery: RouteLines | null };
type VehicleMotion = {
  key: string;
  approach: Leg | null;
  delivery: Leg | null;
  from: number;
  to: number;
  shown: number;
  started: number;
  duration: number;
  fromPoint: Coordinate;
  toPoint: Coordinate;
};

function vehicleRouteKey(vehicle: TrackingFrame['vehicles'][number]): string {
  return JSON.stringify([vehicle.task_id, vehicle.to_pickup, vehicle.to_hospital]);
}

function drawMotion(motion: VehicleMotion, marker: L.Marker | undefined, routes: VehicleRoutes | undefined,
  timestamp: number): boolean {
  const fraction = motion.duration ? Math.min(1, Math.max(0, (timestamp - motion.started) / motion.duration)) : 1;
  motion.shown = motion.from + (motion.to - motion.from) * fraction;
  if (fraction === 1) motion.duration = 0;
  const approachLength = motion.approach?.length ?? 0;
  const location = motion.approach || motion.delivery
    ? motion.approach && motion.shown <= approachLength
      ? pointAt(motion.approach, motion.shown)
      : motion.delivery ? pointAt(motion.delivery, motion.shown - approachLength)
        : motion.approach ? pointAt(motion.approach, motion.shown) : motion.toPoint
    : [motion.fromPoint[0] + (motion.toPoint[0] - motion.fromPoint[0]) * fraction,
      motion.fromPoint[1] + (motion.toPoint[1] - motion.fromPoint[1]) * fraction] as Coordinate;
  marker?.setLatLng(location);
  const approachProgress = Math.min(motion.shown, approachLength);
  const deliveryProgress = Math.max(0, motion.shown - approachLength);
  const approachRemaining = motion.approach ? remaining(motion.approach, approachProgress) : [];
  const deliveryRemaining = motion.delivery ? remaining(motion.delivery, deliveryProgress) : [];
  routes?.approach?.casing.setLatLngs(approachRemaining);
  routes?.approach?.color.setLatLngs(approachRemaining);
  routes?.delivery?.casing.setLatLngs(deliveryRemaining);
  routes?.delivery?.color.setLatLngs(deliveryRemaining);
  return fraction < 1;
}

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

export function DispatchMap({ state, roads, frame, onSelect, pickingRoad, roadPreview, onPick }: {
  state: State; roads: RoadMap | null; frame: TrackingFrame | null; onSelect: (id: string) => void;
  pickingRoad: boolean; roadPreview: RoadSegment | null; onPick: (location: Coordinate) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const layers = useRef<{
    leaf: L.Map;
    roads: L.LayerGroup; routes: L.LayerGroup; sites: L.LayerGroup; events: L.LayerGroup;
    selection: L.LayerGroup; tracking: L.LayerGroup;
    renderer: L.Canvas;
  } | null>(null);
  const vehicleMarkers = useRef(new Map<string, { marker: L.Marker; eta: HTMLSpanElement }>());
  const routeKey = useRef('');
  const siteKey = useRef('');
  const eventKey = useRef('');
  const routeLayers = useRef(new Map<string, VehicleRoutes>());
  const vehicleMotions = useRef(new Map<string, VehicleMotion>());
  const frameKey = useRef('');
  const lastFrameAt = useRef<number | null>(null);
  const animationFrame = useRef<number | null>(null);

  useEffect(() => {
    if (!element.current) return;
    const map = L.map(element.current, { scrollWheelZoom: false, minZoom: 11, maxZoom: 18 })
      .setView([46.060, 14.515], 12);
    map.attributionControl.setPrefix(false);
    map.attributionControl.addAttribution('&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>');
    for (const [name, index] of [['road-base', 300], ['vehicle-paths', 390], ['road-events', 410],
      ['road-selection', 420]] as const) {
      map.createPane(name).style.zIndex = String(index);
    }
    layers.current = {
      leaf: map,
      roads: L.layerGroup().addTo(map), routes: L.layerGroup().addTo(map), sites: L.layerGroup().addTo(map),
      events: L.layerGroup().addTo(map), selection: L.layerGroup().addTo(map), tracking: L.layerGroup().addTo(map),
      renderer: L.canvas({ pane: 'road-base', padding: .35 }),
    };
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
    const resize = new ResizeObserver(() => map.invalidateSize());
    resize.observe(element.current);
    return () => {
      resize.disconnect();
      layers.current = null;
      vehicleMarkers.current.clear();
      routeLayers.current.clear();
      vehicleMotions.current.clear();
      if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current);
      animationFrame.current = null;
      frameKey.current = '';
      lastFrameAt.current = null;
      routeKey.current = siteKey.current = eventKey.current = '';
      map.remove();
    };
  }, []);

  useEffect(() => {
    const map = layers.current;
    if (!map || !pickingRoad) return;
    const container = map.leaf.getContainer();
    container.style.cursor = 'crosshair';
    const pick = (event: L.LeafletMouseEvent) => onPick([event.latlng.lat, event.latlng.lng]);
    map.leaf.on('click', pick);
    return () => {
      container.style.cursor = '';
      map.leaf.off('click', pick);
    };
  }, [pickingRoad, onPick]);

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
    map.selection.clearLayers();
    for (const path of roadPreview?.paths ?? []) {
      if (path.length > 1) {
        L.polyline(path, { pane: 'road-selection', color: '#f08c22', weight: 8, opacity: .8,
          lineCap: 'round', interactive: false }).addTo(map.selection);
      }
    }
  }, [roadPreview]);

  useEffect(() => {
    const map = layers.current;
    if (!map) return;
    const activeFrame = frame?.scenario_id === state.scenario_id ? frame : null;
    const vehicles = activeFrame?.vehicles ?? [];
    const shownTasks = new Set(vehicles.map(vehicle => vehicle.task_id));
    const pickedUpTasks = new Set(vehicles.filter(vehicle =>
      vehicle.task_id && (vehicle.status === 'TO_HOSPITAL' || vehicle.status === 'AT_HOSPITAL'))
      .map(vehicle => vehicle.task_id));
    const pickups = state.tasks.filter(task => (shownTasks.has(task.id) || !state.active_plan)
      && task.actual_pickup == null && task.actual_arrival == null && !pickedUpTasks.has(task.id));
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
      routeLayers.current.clear();
      for (const vehicle of vehicles) {
        const key = vehicleRouteKey(vehicle);
        const current = vehicleMotions.current.get(vehicle.id);
        const shown = current?.key === key ? current.shown : 0;
        const approach = measure(vehicle.to_pickup);
        const delivery = measure(vehicle.to_hospital);
        const approachDistance = Math.min(shown, approach.length);
        const deliveryDistance = Math.max(0, shown - approach.length);
        const lines: VehicleRoutes = { approach: null, delivery: null };
        for (const [leg, distance, dotted] of [[approach, approachDistance, false],
          [delivery, deliveryDistance, true]] as const) {
          if (leg.path.length < 2) continue;
          const style = { pane: 'vehicle-paths', opacity: vehicle.status === 'STOPPED' ? .45 : .95, lineCap: 'round' as const };
          const weight = dotted ? 4 : 3.5;
          const path = remaining(leg, distance);
          const casing = L.polyline(path, { ...style, color: '#fff', weight: weight + 3, interactive: false,
            dashArray: dotted ? '2 8' : undefined }).addTo(map.routes);
          const line = L.polyline(path, { ...style, color: colors[vehicle.id], weight,
            dashArray: dotted ? '2 8' : undefined, className: dotted ? 'route-to-hospital' : 'route-to-pickup' });
          line.bindTooltip(tooltip(`${vehicle.id} · ${dotted ? 'Do ustanove' : 'Do pacienta'}`)).addTo(map.routes);
          if (vehicle.task_id) line.on('click', () => onSelect(vehicle.task_id!));
          if (dotted) lines.delivery = { casing, color: line };
          else lines.approach = { casing, color: line };
        }
        routeLayers.current.set(vehicle.id, lines);
      }
    }

    const events = JSON.stringify([roads?.timestamp, activeFrame?.incidents]);
    if (events !== eventKey.current) {
      eventKey.current = events;
      map.events.clearLayers();
      const byRoad = new Map<string, { name: string; paths: Coordinate[][]; closed: boolean }>();
      for (const event of activeFrame?.incidents ?? []) {
        const road = byRoad.get(event.road_id);
        if (road) road.closed ||= event.type === 'ROAD_CLOSURE';
        else byRoad.set(event.road_id, { name: event.name, paths: event.paths,
          closed: event.type === 'ROAD_CLOSURE' });
      }
      for (const road of byRoad.values()) {
        const title = `${road.closed ? 'Zapora' : 'Zastoj'} · ${road.name}`;
        for (const path of road.paths) {
          if (path.length < 2) continue;
          L.polyline(path, { pane: 'road-events', color: '#fff', weight: 9, interactive: false }).addTo(map.events);
          L.polyline(path, { pane: 'road-events', color: road.closed ? '#920f28' : '#eb2432',
            weight: 6.5, className: road.closed ? 'road-closure' : 'road-traffic' })
            .bindTooltip(tooltip(title)).addTo(map.events);
        }
        if (road.closed && road.paths[0]?.length) {
          const path = road.paths[0];
          const center = (path.length - 1) / 2;
          const a = path[Math.floor(center)], b = path[Math.ceil(center)];
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
      routeLayers.current.delete(id);
      vehicleMotions.current.delete(id);
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
      marker.setOpacity(vehicle.stale ? .55 : 1);
      marker.getElement()?.setAttribute('aria-label', description);
      if (marker.getTooltip()) marker.setTooltipContent(label);
      else marker.bindTooltip(label);
    }

    const nextFrameKey = JSON.stringify([activeFrame?.scenario_id, activeFrame?.now, vehicles]);
    if (nextFrameKey !== frameKey.current) {
      const now = performance.now();
      const duration = Math.min(1600, Math.max(250, lastFrameAt.current === null ? 1000 : now - lastFrameAt.current));
      for (const vehicle of vehicles) {
        const key = vehicleRouteKey(vehicle);
        const approach = vehicle.to_pickup && vehicle.to_pickup.length > 1 ? measure(vehicle.to_pickup) : null;
        const delivery = vehicle.to_hospital && vehicle.to_hospital.length > 1 ? measure(vehicle.to_hospital) : null;
        const target = progress(vehicle, approach, delivery);
        const marker = vehicleMarkers.current.get(vehicle.id)?.marker;
        const current = vehicleMotions.current.get(vehicle.id);
        const routeChanged = !current || current.key !== key;
        const point = [vehicle.location[0], vehicle.location[1]] as Coordinate;
        if (routeChanged) {
          vehicleMotions.current.set(vehicle.id, {
            key, approach, delivery, from: target, to: target, shown: target, started: now, duration: 0,
            fromPoint: point, toPoint: point,
          });
          continue;
        }

        const fromPoint = marker?.getLatLng();
        const startPoint: Coordinate = fromPoint ? [fromPoint.lat, fromPoint.lng] : current.toPoint;
        const moving = approach || delivery
          ? Math.abs(target - current.shown) > .01
          : point[0] !== current.toPoint[0] || point[1] !== current.toPoint[1];
        vehicleMotions.current.set(vehicle.id, {
          ...current, approach, delivery, from: current.shown, to: target, shown: current.shown,
          started: now, duration: moving ? duration : 0, fromPoint: startPoint, toPoint: point,
        });
      }
      frameKey.current = nextFrameKey;
      lastFrameAt.current = now;
    }

    let moving = false;
    for (const [id, motion] of vehicleMotions.current) {
      moving = drawMotion(motion, vehicleMarkers.current.get(id)?.marker, routeLayers.current.get(id), performance.now()) || moving;
    }
    if (moving && animationFrame.current === null) {
      const animate = (timestamp: number) => {
        animationFrame.current = null;
        let stillMoving = false;
        for (const [id, motion] of vehicleMotions.current) {
          stillMoving = drawMotion(motion, vehicleMarkers.current.get(id)?.marker, routeLayers.current.get(id), timestamp) || stillMoving;
        }
        if (stillMoving) animationFrame.current = requestAnimationFrame(animate);
      };
      animationFrame.current = requestAnimationFrame(animate);
    }
  }, [state, roads, frame, onSelect]);

  return <div ref={element} className="dispatch-map" aria-label="Zemljevid cest in reševalnih vozil" />;
}
