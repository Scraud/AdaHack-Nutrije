import type { components } from './api';

type Schema = components['schemas'];
export type State = Schema['State'];
export type Plan = Schema['PlanView'];
export type PlanSummary = Schema['PlanSummary'];
export type Assignment = Schema['Assignment'];
export type Incident = Schema['CreateIncident'];
export type Recommendation = Schema['RecommendationView'];
export type Recommendations = Schema['Recommendations'];
export type Explanation = Schema['Explanation'];
export type Issue = Schema['Issue'];
export type NewTask = Schema['NewTask'];
export type Point = Schema['Point'];
export type Condition = Schema['SourceStatus'];
export type RoadMap = Schema['RoadMap'];
export type TrackingFrame = Schema['TrackingFrame'];
export type Playback = Schema['Playback'];

const localTime = new Intl.DateTimeFormat('sl-SI', {
  timeZone: 'Europe/Ljubljana', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function clock(start: string, seconds: number): string {
  return localTime.format(new Date(Date.parse(start) + seconds * 1000));
}
