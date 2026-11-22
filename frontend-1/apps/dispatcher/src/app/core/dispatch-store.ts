import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import type {
  Condition, Explanation, Incident, Plan, PlanSummary, Playback, Recommendation, Recommendations, RoadMap, State,
  TrackingFrame,
} from '../../../../../packages/contracts';

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.detail?.message || (response.status === 422
      ? 'Preverite obvezne podatke in časovna okna.'
      : `Zahteva ni uspela (${response.status}).`));
  }
  return response.json();
}

@Injectable({ providedIn: 'root' })
export class DispatchStore {
  readonly state = signal<State | null>(null);
  readonly history = signal<PlanSummary[]>([]);
  readonly recommendations = signal<Recommendation[]>([]);
  readonly sources = signal<Condition[]>([]);
  readonly sourcesBusy = signal(false);
  readonly preview = signal<Plan | null>(null);
  readonly previewId = signal('');
  readonly busy = signal('');
  readonly notification = signal('');
  readonly error = signal('');
  readonly openRecommendations = computed(() => this.recommendations().filter(item => item.status === 'PROPOSED'));
  readonly explanations = signal<Record<string, Explanation>>({});
  readonly explaining = signal('');
  readonly roads = signal<RoadMap | null>(null);
  readonly roadId = signal('');
  readonly tracking = signal<TrackingFrame | null>(null);
  readonly gpsOnline = computed(() => this.tracking()?.vehicles.some(vehicle => !vehicle.stale) ?? false);
  readonly trackingOffline = signal(false);
  private readonly destroy = inject(DestroyRef);
  private trackingTimer?: ReturnType<typeof setInterval>;
  private trackingPending = false;

  constructor() {
    this.destroy.onDestroy(() => clearInterval(this.trackingTimer));
  }

  async run(label: string, action: () => Promise<void>) {
    if (this.busy()) return;
    this.busy.set(label);
    this.error.set('');
    this.notification.set('');
    try {
      await action();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Povezava ni uspela.');
      await this.sync().catch(() => undefined);
    } finally {
      this.busy.set('');
    }
  }

  async sync() {
    const state = await request<State>('state');
    this.state.set(state);
    await this.refreshLists();
  }

  initialize() {
    void this.run('Nalaganje stanja', () => this.sync());
    void this.refreshSources();
    void this.loadRoads();
    if (!this.trackingTimer) {
      this.trackingTimer = setInterval(() => void this.refreshTracking(), 1000);
    }
    void this.refreshTracking();
  }

  async loadRoads() {
    if (this.roads()) return;
    try {
      const roads = await request<RoadMap>('map/roads');
      this.roads.set(roads);
      this.roadId.set(roads.segments[0]?.id ?? '');
    } catch {
      this.roads.set(null);
    }
  }

  async refreshTracking(force = false) {
    if (this.trackingPending || (this.busy() && !force)) return;
    this.trackingPending = true;
    try {
      const frame = await request<TrackingFrame>('tracking');
      const before = this.state();
      if (!before || frame.scenario_id !== before.scenario_id || frame.revision >= before.revision) {
        if ((frame.scenario_id !== before?.scenario_id || frame.revision !== before?.revision) && !this.busy()) {
          const current = await request<State>('state');
          if (!this.busy()) {
            this.state.set(current);
            if (current.scenario_id !== before?.scenario_id || current.active_plan?.id !== before?.active_plan?.id
              || current.incidents.length !== before?.incidents.length || this.openRecommendations().length) {
              await this.refreshLists();
            }
          }
        }
        const current = this.state();
        if (!current || (frame.scenario_id === current.scenario_id && frame.revision >= current.revision)) {
          this.tracking.set(frame);
        }
      }
      this.trackingOffline.set(false);
    } catch {
      this.trackingOffline.set(true);
    } finally {
      this.trackingPending = false;
    }
  }

  setPlayback(playing: boolean, speed: Playback['speed'] = 60) {
    return this.run(playing ? 'Zagon simulacije' : 'Premor simulacije', async () => {
      const playback = await request<Playback>('tracking/playback', 'POST', { playing, speed });
      this.tracking.update(frame => frame ? { ...frame, playback } : frame);
      await this.refreshTracking(true);
    });
  }

  private async refreshLists() {
    const [history, items] = await Promise.all([
      request<PlanSummary[]>('plans'),
      request<Recommendation[]>('recommendations'),
    ]);
    this.history.set(history);
    this.recommendations.set(items);
    if (this.previewId() && !items.some(item => item.id === this.previewId() && item.status === 'PROPOSED')) {
      this.clearPreview();
    }
  }

  changeState(path: string, label: string, body?: unknown, done?: string) {
    return this.run(label, async () => {
      this.state.set(await request<State>(path, 'POST', body));
      this.clearPreview();
      await this.refreshLists();
      await this.refreshTracking(true);
      this.notification.set(done ?? '');
    });
  }

  incident(body: Incident) {
    return this.changeState('incidents', 'Zapisovanje motnje', body, 'Motnja je zabeležena.');
  }

  generate() {
    if (!this.state()?.active_plan) return;
    void this.run('Izračun alternativ', async () => {
      if (this.tracking()?.playback.playing) {
        await request<Playback>('tracking/playback', 'POST', { playing: false });
        await this.sync();
      }
      const state = this.state();
      if (!state?.active_plan) return;
      const response = await request<Recommendations>('recommendations/generate', 'POST', {
        base_plan_id: state.active_plan.id, expected_state_revision: state.revision,
      });
      this.recommendations.set(response.items);
      this.clearPreview();
      if (response.items.length > 1) {
        this.notification.set(`Najdeni različni predlogi: ${response.items.length} · ${response.duration_ms} ms.`);
      } else if (response.items.length === 1) {
        this.notification.set('V časovnem proračunu je bil najden en različen predlog.');
      } else {
        const detail = response.solver_statuses.includes('INFEASIBLE')
          ? 'Model je neizvedljiv ob trenutnih omejitvah.'
          : 'Izračun ni vrnil predloga. Preverite motnje ali ponovite izračun.';
        this.notification.set(detail);
      }
    });
  }

  async explain(item: Recommendation) {
    if (this.explaining()) return;
    this.explaining.set(item.id);
    this.error.set('');
    try {
      const result = await request<Explanation>(`recommendations/${item.id}/explanation`);
      this.explanations.update(all => ({ ...all, [item.id]: result }));
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Analize predloga ni bilo mogoče pripraviti.');
    } finally {
      this.explaining.set('');
    }
  }

  select(item: Recommendation) {
    this.preview.set(item.plan);
    this.previewId.set(item.id);
  }

  clearPreview() {
    this.preview.set(null);
    this.previewId.set('');
  }

  decide(item: Recommendation, accept: boolean, reason = '') {
    void this.run(accept ? 'Potrjevanje plana' : 'Zavračanje predloga', async () => {
      await request(`recommendations/${item.id}/${accept ? 'accept' : 'reject'}`, 'POST',
        accept ? undefined : { reason });
      this.clearPreview();
      await this.sync();
      this.notification.set(accept ? 'Nova verzija plana je aktivna.' : 'Predlog je zavrnjen.');
    });
  }

  async openHistory(id: string) {
    await this.run('Nalaganje verzije', async () => {
      this.preview.set(await request<Plan>(`plans/${id}`));
      this.previewId.set('');
    });
  }

  async refreshSources(refresh = false) {
    if (this.sourcesBusy()) return;
    this.sourcesBusy.set(true);
    try {
      this.sources.set(await request<Condition[]>(`conditions${refresh ? '/refresh' : ''}`, refresh ? 'POST' : 'GET'));
    } catch {
      this.sources.set([]);
      if (refresh) this.error.set('Stanja zunanjih virov ni bilo mogoče naložiti.');
    } finally {
      this.sourcesBusy.set(false);
    }
  }
}
