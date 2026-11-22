import type { TrackingFrame } from '../../contracts';

export type Coordinate = [number, number];

export type Leg = {
  path: Coordinate[];
  cumulative: number[];
  length: number;
};

const earthRadius = 6_371_008.8;
const radians = Math.PI / 180;

function distanceBetween(a: Coordinate, b: Coordinate): number {
  const y = (b[0] - a[0]) * radians * earthRadius;
  const x = (b[1] - a[1]) * radians * earthRadius * Math.cos((a[0] + b[0]) / 2 * radians);
  return Math.hypot(x, y);
}

export function measure(path: readonly Coordinate[] | undefined): Leg {
  const coordinates = path?.map(point => [point[0], point[1]] as Coordinate) ?? [];
  const cumulative = [0];
  for (let index = 1; index < coordinates.length; index++) {
    cumulative.push(cumulative[index - 1] + distanceBetween(coordinates[index - 1], coordinates[index]));
  }
  return { path: coordinates, cumulative, length: cumulative[cumulative.length - 1] ?? 0 };
}

export function pointAt(leg: Leg, distance: number): Coordinate {
  if (!leg.path.length) return [0, 0];
  if (distance <= 0) return [...leg.path[0]];
  if (distance >= leg.length) return [...leg.path[leg.path.length - 1]];

  for (let index = 0; index < leg.path.length - 1; index++) {
    const start = leg.cumulative[index];
    const end = leg.cumulative[index + 1];
    if (distance > end || end === start) continue;
    const fraction = (distance - start) / (end - start);
    const a = leg.path[index], b = leg.path[index + 1];
    return [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction];
  }
  return [...leg.path[leg.path.length - 1]];
}

export function remaining(leg: Leg, distance: number): Coordinate[] {
  if (!leg.path.length || distance >= leg.length) return [];
  const shown = Math.max(0, distance);
  let index = 0;
  while (index < leg.path.length - 1 && leg.cumulative[index + 1] <= shown) index++;
  return [pointAt(leg, shown), ...leg.path.slice(index + 1).map(point => [...point] as Coordinate)];
}

function projection(leg: Leg, point: Coordinate): { distance: number; offset: number } {
  if (leg.path.length < 2) return { distance: 0, offset: Number.POSITIVE_INFINITY };
  let bestDistance = 0;
  let bestOffset = Number.POSITIVE_INFINITY;
  const scale = earthRadius * radians;
  const cosine = Math.cos(point[0] * radians);

  for (let index = 0; index < leg.path.length - 1; index++) {
    const a = leg.path[index], b = leg.path[index + 1];
    const dx = (b[1] - a[1]) * scale * cosine;
    const dy = (b[0] - a[0]) * scale;
    const px = (point[1] - a[1]) * scale * cosine;
    const py = (point[0] - a[0]) * scale;
    const squaredLength = dx * dx + dy * dy;
    const fraction = squaredLength ? Math.max(0, Math.min(1, (px * dx + py * dy) / squaredLength)) : 0;
    const offset = Math.hypot(px - dx * fraction, py - dy * fraction);
    if (offset < bestOffset) {
      bestOffset = offset;
      bestDistance = leg.cumulative[index] + (leg.cumulative[index + 1] - leg.cumulative[index]) * fraction;
    }
  }
  return { distance: bestDistance, offset: bestOffset };
}

export function project(leg: Leg | null, point: Coordinate): number {
  return leg ? projection(leg, point).distance : 0;
}

export function progress(
  vehicle: TrackingFrame['vehicles'][number], approach: Leg | null, delivery: Leg | null,
): number {
  const approachLength = approach?.length ?? 0;
  const totalLength = approachLength + (delivery?.length ?? 0);
  switch (vehicle.status) {
    case 'WAITING': return 0;
    case 'TO_PICKUP': return project(approach, vehicle.location);
    case 'AT_PICKUP': return approachLength;
    case 'TO_HOSPITAL': return approachLength + project(delivery, vehicle.location);
    case 'AT_HOSPITAL': return totalLength;
    case 'STOPPED':
    case 'GPS': {
      const candidates = [
        approach ? { offset: projection(approach, vehicle.location).offset,
          distance: project(approach, vehicle.location) } : null,
        delivery ? { offset: projection(delivery, vehicle.location).offset,
          distance: approachLength + project(delivery, vehicle.location) } : null,
      ].filter((candidate): candidate is { offset: number; distance: number } => candidate !== null);
      return candidates.sort((a, b) => a.offset - b.offset)[0]?.distance ?? 0;
    }
  }
}