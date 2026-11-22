import { useId, useRef, useState, type CSSProperties, type DragEvent, type FocusEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { PRIORITY_LABELS } from '../../contracts';
import { colorFor, equipmentLabel, formatTime, latestPickupLabel, passengerOnBoard, timelineStatus, timelineBounds } from '../../contracts/plan-utils';
import type { DispatchViewProps } from './types';

const taskStatuses = { active: 'V izvajanju', future: 'Načrtovano', completed: 'Opravljeno', failed: 'Neuspešno ali blokirano' };

type TooltipPosition = {
  id: string;
  left: number;
  top: number;
  above: boolean;
  host: HTMLElement;
};

export function VehicleTimeline(props: DispatchViewProps) {
  const [tooltip, setTooltip] = useState<TooltipPosition | null>(null);
  const drag = useRef<{ taskId: string; offset: number } | null>(null);
  const [drop, setDrop] = useState<{ vehicleId: string; pickup: string } | null>(null);
  const tooltipId = useId();
  const { start, end } = timelineBounds(props.state);
  const position = (value: string) => Math.max(0, Math.min(100, (Date.parse(value) - start) / (end - start) * 100));
  const hours = Array.from({ length: Math.round((end - start) / 3_600_000) + 1 }, (_, i) => new Date(start + i * 3_600_000).toISOString());
  const now = position(props.state.simulated_time);
  const tasks = new Map(props.state.tasks.map(task => [task.id, task]));
  const tooltipTask = tooltip ? tasks.get(tooltip.id) : undefined;
  const tooltipAssignment = props.plan?.assignments.find(assignment => assignment.task_id === tooltip?.id);

  function timeAt(event: DragEvent, track: Element) {
    const { left, width } = track.getBoundingClientRect();
    return start + (event.clientX - left) / width * (end - start);
  }

  function beginDrag(event: DragEvent<HTMLButtonElement>, taskId: string, pickup?: string) {
    const track = event.currentTarget.closest('.timeline-track');
    drag.current = { taskId, offset: pickup && track ? Date.parse(pickup) - timeAt(event, track) : 0 };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', taskId);
    setTooltip(null);
  }

  function endDrag() {
    drag.current = null;
    setDrop(null);
  }

  function dropTime(event: DragEvent<HTMLDivElement>, offset: number) {
    const time = Math.round((timeAt(event, event.currentTarget) + offset) / 60_000) * 60_000;
    return new Date(Math.max(Date.parse(props.state.horizon_start), Math.min(Date.parse(props.state.horizon_end), time))).toISOString();
  }

  function showTooltip(id: string, event: MouseEvent<HTMLButtonElement> | FocusEvent<HTMLButtonElement>) {
    const button = event.currentTarget;
    const bounds = button.getBoundingClientRect();
    const above = bounds.top >= 215 || bounds.top > window.innerHeight - bounds.bottom;
    const width = Math.min(292, window.innerWidth - 16);
    setTooltip({
      id, above,
      left: Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8)),
      top: above ? bounds.top - 6 : bounds.bottom + 6,
      host: button.closest('dialog') ?? document.body,
    });
  }

  function taskButtonEvents(id: string) {
    return {
      onMouseEnter: (event: MouseEvent<HTMLButtonElement>) => showTooltip(id, event),
      onMouseLeave: () => setTooltip(null),
      onFocus: (event: FocusEvent<HTMLButtonElement>) => showTooltip(id, event),
      onBlur: () => setTooltip(null),
      onClick: () => { setTooltip(null); props.onSelectTask(id); },
      'aria-describedby': tooltip?.id === id ? tooltipId : undefined,
    };
  }

  return <>
    <div className="timeline-scroll" onScroll={() => setTooltip(null)}><div className="timeline-inner" style={{minWidth:Math.max(810,hours.length*60)}}>
      <div className="timeline-axis">
        <span>VOZILO</span>
        <div>
          {hours.map((time, i) => <span key={time} style={{ left: `${i / (hours.length - 1) * 100}%` }}>{formatTime(time)}</span>)}
          <b className="now-label" style={{ left: `${now}%` }}>{formatTime(props.state.simulated_time)}</b>
        </div>
      </div>
      <div className="timeline-rows">
        {props.state.vehicles.map(vehicle => {
          const carrying = passengerOnBoard(props.state, vehicle.id);
          const broken = vehicle.status === 'BROKEN';
          const breakdown = props.state.incidents.find(incident => incident.incident_type === 'VEHICLE_BREAKDOWN' && incident.affected_vehicle_ids.includes(vehicle.id));
          const vehicleColor = colorFor(vehicle.id);
          const selected = props.selectedVehicleId === vehicle.id;
          return <div key={vehicle.id} className={`timeline-row ${selected ? 'selected' : ''} ${props.diff.vehicle_ids.has(vehicle.id) ? 'affected' : ''} ${carrying ? 'has-passenger' : ''} ${broken ? 'vehicle-broken' : ''}`} style={{ '--vehicle-color': vehicleColor } as CSSProperties}>
            <button className="timeline-vehicle" onClick={() => props.onSelectVehicle(vehicle.id)} aria-pressed={selected}
              title={broken ? 'Vozilo je pokvarjeno' : carrying ? 'Oseba je trenutno v vozilu' : vehicle.vehicle_type}>
              <i style={{ background: broken ? '#cb7467' : vehicleColor }}/>{vehicle.code}
              <span>{broken ? 'Okvara' : carrying ? 'V prevozu' : vehicle.vehicle_type === 'Prevoz z vozičkom' ? 'Voziček' : 'Sanitetno'}</span>
              {carrying && <b className="passenger-indicator" aria-label="Oseba v vozilu">●</b>}
            </button>
            <div className={`timeline-track ${drop?.vehicleId === vehicle.id ? 'timeline-drop-target' : ''}`}
              data-vehicle-id={vehicle.id}
              onDragOver={event => {
                if (!props.onMoveTask || broken || !drag.current) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDrop({ vehicleId: vehicle.id, pickup: dropTime(event, drag.current.offset) });
              }}
              onDragLeave={event => {
                if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                  setDrop(current => current?.vehicleId === vehicle.id ? null : current);
                }
              }}
              onDrop={event => {
                if (!props.onMoveTask || broken || !drag.current) return;
                event.preventDefault();
                const { taskId, offset } = drag.current;
                endDrag();
                props.onMoveTask(taskId, vehicle.id, dropTime(event, offset));
              }}>
              {hours.map((time, i) => <i className="timeline-gridline" key={time} style={{ left: `${i / (hours.length - 1) * 100}%` }}/>)}
              {broken && <span className="breakdown-region" style={{ left: `${breakdown ? position(breakdown.occurred_at) : now}%` }}>
                <small>Okvara {breakdown ? formatTime(breakdown.occurred_at) : ''}</small>
              </span>}
              {props.isPreview && props.basePlan?.assignments.filter(a => a.vehicle_id === vehicle.id && (props.diff.changed.has(a.task_id) || props.diff.removed.has(a.task_id))).map(a =>
                <span key={a.id} className="task-ghost" style={{ left: `${position(a.planned_departure)}%`, width: `${position(a.planned_end) - position(a.planned_departure)}%` }} title={`Prejšnja dodelitev ${a.task_id}`}>{a.task_id}</span>)}
              {props.plan?.assignments.filter(a => a.vehicle_id === vehicle.id).map(assignment => {
                const id = assignment.task_id;
                const task = tasks.get(id);
                const status = timelineStatus(props.state, assignment, props.isPreview);
                const added = props.diff.added.has(id);
                const changed = props.diff.changed.has(id);
                const editable = !!props.onMoveTask && assignment.status === 'PLANNED' && !assignment.is_locked && !task?.actual_pickup;
                const pickupTime = formatTime(assignment.planned_pickup);
                const label = [id, vehicle.code, task && PRIORITY_LABELS[task.priority], taskStatuses[status], `Prevzem ${pickupTime}`].filter(Boolean).join(' · ');
                return <button key={id} className={`timeline-task task-${status} ${added ? 'preview-added' : ''} ${changed ? 'preview-changed' : ''} ${props.selectedTaskId === id ? 'task-selected' : ''}`}
                  data-priority={task?.priority} data-task-id={id} aria-label={label} {...taskButtonEvents(id)}
                  draggable={editable} onDragStart={editable ? event => beginDrag(event, id, assignment.planned_pickup) : undefined} onDragEnd={endDrag}
                  style={{ left: `${position(assignment.planned_departure)}%`, width: `${Math.max(1, position(assignment.planned_end) - position(assignment.planned_departure))}%` }}>
                  <b className="phase-task-label">{status === 'failed' ? '! ' : added ? '+ ' : ''}{id}</b>
                  <time className="timeline-arrival" dateTime={assignment.planned_pickup}>{pickupTime}</time>
                </button>;
              })}
              {drop?.vehicleId === vehicle.id && <span className="timeline-drop-marker" aria-hidden="true"
                style={{ left: `${position(drop.pickup)}%` }}>{formatTime(drop.pickup)}</span>}
              <span className="now-line" style={{ left: `${now}%` }}/>
            </div>
          </div>;
        })}
      </div>
      {!!props.plan?.unassigned_task_ids.length && <div className="unassigned-strip"><b>Nerazporejeno</b>
        {props.plan.unassigned_task_ids.map(id => <button key={id} data-priority={tasks.get(id)?.priority} data-task-id={id}
          draggable={!!props.onMoveTask && !tasks.get(id)?.actual_pickup}
          onDragStart={props.onMoveTask ? event => beginDrag(event, id) : undefined} onDragEnd={endDrag}
          {...taskButtonEvents(id)}>{id} · čaka na dodelitev</button>)}
      </div>}
      {props.diff.removed.size > 0 && <div className="unassigned-strip"><b>Odstranjene dodelitve</b>
        {[...props.diff.removed].map(id => <button key={id} onClick={() => props.onSelectTask(id)}>{id} · brez prejšnje dodelitve</button>)}
      </div>}
    </div></div>
    <div className="timeline-footer">
      <div className="timeline-key" aria-label="Barve prioritet">
        {Object.entries(PRIORITY_LABELS).map(([priority, label]) => <span key={priority} data-priority={priority}><i aria-hidden="true"/>{label}</span>)}
      </div>
      {props.onMoveTask && <small>Povlecite nalogo na želeni čas in vozilo ali jo odprite za ročno urejanje.</small>}
    </div>
    {tooltip && tooltipTask && createPortal(
      <div id={tooltipId} className="task-tooltip" role="tooltip"
        style={{ left: tooltip.left, top: tooltip.top, transform: tooltip.above ? 'translateY(-100%)' : undefined }}>
        <div><b>{tooltipTask.id}{tooltipAssignment && ` · ${tooltipAssignment.vehicle_id}`}</b>
          <span data-priority={tooltipTask.priority}>{PRIORITY_LABELS[tooltipTask.priority]}</span></div>
        <strong>{tooltipTask.origin.name}</strong><p>do {tooltipTask.destination.name}</p>
        <dl className="timeline-tooltip-times">
          <div><dt>Želeni prevzem</dt><dd>{formatTime(tooltipTask.earliest_pickup)}</dd></div>
          <div><dt>Najkasneje v vozilu</dt><dd>{latestPickupLabel(tooltipTask)}</dd></div>
          <div><dt>Načrtovan prevzem</dt><dd>{tooltipAssignment ? formatTime(tooltipAssignment.planned_pickup) : 'Čaka na dodelitev'}</dd></div>
        </dl>
        {tooltipTask.required_equipment.length > 0 && <p>{tooltipTask.required_equipment.map(equipmentLabel).join(' · ')}</p>}
      </div>, tooltip.host,
    )}
  </>;
}
