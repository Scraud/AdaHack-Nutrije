import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { clock, type NewTask, type State } from '../../../../../packages/contracts';
import { DispatchStore } from '../core/dispatch-store';
import { incidentLabels } from '../core/labels';

@Component({
  selector: 'incident-center',
  imports: [FormsModule],
  templateUrl: './incident-center.html',
})
export class IncidentCenter {
  readonly state = input.required<State>();
  readonly store = inject(DispatchStore);
  readonly formOpen = signal(false);
  readonly resetOpen = signal(false);
  readonly labels = incidentLabels;
  readonly clock = clock;
  readonly lastEvents = computed(() => [...this.state().incidents].reverse().slice(0, 5));
  readonly activeRoadEvents = computed(() => {
    const now = this.state().now;
    const names = new Map((this.store.tracking()?.incidents ?? []).map(event => [event.id, event.name]));
    return this.state().incidents.filter(event =>
      (event.type === 'TRAFFIC_DELAY' || event.type === 'ROAD_CLOSURE') && event.road_id
      && event.ended_at == null && event.occurred_at <= now
      && (event.duration == null || now < event.occurred_at + event.duration))
      .map(event => ({ ...event, roadName: names.get(event.id) ?? this.roadName(event.road_id!) }));
  });
  priority: NewTask['priority'] = 'P1';
  pickup = '11:35';
  deadline = '12:30';
  equipment: 'OXYGEN' | 'STRETCHER' | 'WHEELCHAIR' = 'OXYGEN';
  facility = 'F3';
  passengers = 1;
  advanceTo = '11:20';
  streetName = '';
  error = '';

  findStreet() {
    if (this.streetName.trim()) void this.store.findStreet(this.streetName);
  }

  openTask() {
    const current = this.state().now;
    this.pickup = clock(this.state().start_at, Math.min(36000, current + 15 * 60));
    this.deadline = clock(this.state().start_at, Math.min(36000, current + 60 * 60));
    this.error = '';
    this.formOpen.set(!this.formOpen());
  }

  private offset(value: string) {
    if (!/^\d\d:\d\d$/.test(value)) return NaN;
    const [hours, minutes] = value.split(':').map(Number);
    return (hours * 60 + minutes - 480) * 60;
  }

  async createTask() {
    const earliest = this.offset(this.pickup);
    const latest = this.offset(this.deadline);
    if (!Number.isFinite(earliest) || !Number.isFinite(latest) || earliest < this.state().now ||
      latest > 36000 || latest <= earliest || !Number.isInteger(this.passengers) || this.passengers < 1 || this.passengers > 8) {
      this.error = 'Določite čas prevzema in kasnejši rok do 18:00 ter od 1 do 8 potnikov.';
      return;
    }
    await this.store.incident({ type: 'NEW_TASK', task: {
      priority: this.priority, facility_id: this.facility, pickup: { lat: 46.068, lon: 14.542 },
      earliest_pickup: earliest, preferred_arrival: Math.floor((earliest + latest) / 2), latest_arrival: latest,
      equipment: [this.equipment], passenger_count: this.passengers,
    } });
    if (!this.store.error()) this.formOpen.set(false);
  }

  moveClock() {
    const to = this.offset(this.advanceTo);
    if (!Number.isFinite(to) || to <= this.state().now || to > 36000) {
      this.error = 'Izberite kasnejši čas do 18:00.';
      return;
    }
    this.error = '';
    void this.store.changeState('demo/advance-time', 'Premik simulirane ure', { to });
  }

  traffic(type: 'TRAFFIC_DELAY' | 'ROAD_CLOSURE') {
    const road_id = this.store.roadTarget()?.id;
    if (road_id) void this.store.incident({ type, road_id, duration: 5400, multiplier: 2.3 });
  }

  roadName(id: string) {
    return id.startsWith('street:') ? id.slice('street:'.length)
      : this.store.roadTarget()?.id === id ? this.store.roadTarget()!.name : 'Izbrana cesta';
  }

  reset() {
    this.resetOpen.set(false);
    this.error = '';
    this.formOpen.set(false);
    this.advanceTo = '11:20';
    void this.store.changeState('demo/reset', 'Ponastavitev podatkov', undefined, 'Demo je ponastavljen.');
  }
}
