import { AfterViewInit, Component, ElementRef, OnChanges, OnDestroy, input, output } from '@angular/core';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DispatchMap } from '../../../../../packages/react-views/src/dispatch-map';
import { VehicleTimeline } from '../../../../../packages/react-views/src/vehicle-timeline';
import type { Plan, RoadMap, State, TrackingFrame } from '../../../../../packages/contracts';

@Component({ selector: 'react-view', template: '' })
export class ReactViewHost implements AfterViewInit, OnChanges, OnDestroy {
  readonly kind = input.required<'map' | 'timeline'>();
  readonly state = input.required<State>();
  readonly plan = input<Plan | null>(null);
  readonly roads = input<RoadMap | null>(null);
  readonly tracking = input<TrackingFrame | null>(null);
  readonly selectTask = output<string>();
  private root?: Root;
  private readonly onSelect = (id: string) => this.selectTask.emit(id);

  constructor(private readonly host: ElementRef<HTMLElement>) {}

  ngAfterViewInit() {
    this.root = createRoot(this.host.nativeElement);
    this.render();
  }

  ngOnChanges() { this.render(); }
  ngOnDestroy() { this.root?.unmount(); }

  private render() {
    if (!this.root) return;
    const props = { state: this.state(), onSelect: this.onSelect };
    this.root.render(this.kind() === 'map'
      ? createElement(DispatchMap, { ...props, roads: this.roads(), frame: this.tracking() })
      : createElement(VehicleTimeline, { ...props, plan: this.plan() }));
  }
}
