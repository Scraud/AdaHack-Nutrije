import { AfterViewInit, Component, ElementRef, Input, NgZone, OnChanges, OnDestroy, inject } from '@angular/core';
import { mount, type DispatchViewProps, type ViewKind } from '@rescueflow/react-views/src';

@Component({selector:'react-view-host',standalone:true,template:'',host:{class:'react-view-host'}})
export class ReactViewHost implements AfterViewInit,OnChanges,OnDestroy {
  @Input({required:true}) kind!:ViewKind;
  @Input({required:true}) viewProps!:DispatchViewProps;
  private readonly element=inject(ElementRef<HTMLElement>);
  private readonly zone=inject(NgZone);
  private view?:ReturnType<typeof mount>;
  ngAfterViewInit() { this.zone.runOutsideAngular(()=>this.view=mount(this.element.nativeElement,this.kind,this.viewProps)); }
  ngOnChanges() { if(this.view) this.zone.runOutsideAngular(()=>this.view!.update(this.viewProps)); }
  ngOnDestroy() { this.view?.unmount(); }
}
