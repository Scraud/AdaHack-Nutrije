import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import type { Point, State } from '../../contracts';

export function DispatchMap({ state, onSelect }: { state: State; onSelect: (id: string) => void }) {
  const element = useRef<HTMLDivElement>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const [tilesUnavailable, setTilesUnavailable] = useState(false);

  useEffect(() => {
    if (!element.current) return;
    const map = L.map(element.current, { scrollWheelZoom: false }).setView([46.060, 14.521], 12);
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    });
    tiles.on('tileerror', () => setTilesUnavailable(true)).addTo(map);
    layer.current = L.layerGroup().addTo(map);
    const resize = new ResizeObserver(() => map.invalidateSize());
    resize.observe(element.current);
    return () => { resize.disconnect(); layer.current = null; map.remove(); };
  }, []);

  useEffect(() => {
    const group = layer.current;
    if (!group) return;
    group.clearLayers();
    const marker = (point: Point, label: string, color: string, radius: number, select?: () => void) => {
      const tooltip = document.createElement('span');
      tooltip.textContent = label;
      const dot = L.circleMarker([point.lat, point.lon], {
        color: '#fff', weight: 2, fillColor: color, fillOpacity: 1, radius,
      }).bindTooltip(tooltip).addTo(group);
      if (select) dot.on('click', select);
    };
    for (const site of state.facilities) marker(site.location, site.name, '#6e54c6', 8);
    for (const task of state.tasks) marker(task.pickup, task.id, '#087e80', 5, () => onSelect(task.id));
    for (const vehicle of state.vehicles) {
      marker(vehicle.location, vehicle.id, vehicle.broken ? '#bc532a' : '#1f58a7', 9);
    }
    for (const event of state.incidents) {
      if (!event.location || !['TRAFFIC_DELAY', 'ROAD_CLOSURE', 'WEATHER_DELAY'].includes(event.type)
        || (event.duration && (event.occurred_at ?? 0) + event.duration <= state.now)) continue;
      L.circle([event.location.lat, event.location.lon], {
        radius: (event.radius_km ?? 1.5) * 1000,
        color: '#a94425', weight: 2, fillOpacity: .12, dashArray: '4 5',
      }).addTo(group);
    }
  }, [state, onSelect]);

  return <>
    <div ref={element} className="dispatch-map" aria-label="Zemljevid vozil, prevzemov in ustanov" />
    {tilesUnavailable && <p className="map-notice">Zemljevidne ploščice niso dosegljive. Prikazane so lokacije po koordinatah.</p>}
  </>;
}
