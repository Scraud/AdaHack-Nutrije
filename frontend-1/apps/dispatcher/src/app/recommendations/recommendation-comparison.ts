import { Component, inject, input } from '@angular/core';
import { clock, type State } from '../../../../../packages/contracts';
import { DispatchStore } from '../core/dispatch-store';
import { issueLabels, strategies } from '../core/labels';

@Component({
  selector: 'recommendation-comparison',
  templateUrl: './recommendation-comparison.html',
})
export class RecommendationComparison {
  readonly state = input.required<State>();
  readonly store = inject(DispatchStore);
  readonly strategies = strategies;
  readonly issues = issueLabels;
  readonly clock = clock;
  minutes(seconds: number) { return Math.round(seconds / 60); }
}
