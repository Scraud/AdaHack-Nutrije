import { Injectable, computed, signal } from '@angular/core';
import type {
  Condition, Incident, Plan, PlanSummary, Recommendation, Recommendations, State,
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
      this.notification.set(done ?? '');
    });
  }

  incident(body: Incident) {
    return this.changeState('incidents', 'Zapisovanje motnje', body, 'Motnja je zabeležena.');
  }

  generate() {
    const state = this.state();
    if (!state?.active_plan) return;
    void this.run('Izračun alternativ', async () => {
      const response = await request<Recommendations>('recommendations/generate', 'POST', {
        base_plan_id: state.active_plan?.id, expected_state_revision: state.revision,
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
