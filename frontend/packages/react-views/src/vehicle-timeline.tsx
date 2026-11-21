import { clock, type Assignment, type Plan, type State } from '../../contracts';

function duration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (!minutes) return `${remainder} s`;
  return remainder ? `${minutes} min ${remainder} s` : `${minutes} min`;
}

function tripPhases(row: Assignment, pickupService: number) {
  const beforePickup = row.planned_pickup - row.planned_departure;
  const approach = Math.min(row.deadhead, beforePickup);
  const pickupEnd = Math.min(row.planned_dropoff, row.planned_pickup + pickupService);
  return [
    { label: 'Vožnja do pacienta', seconds: approach, driving: true },
    { label: 'Čakanje in prevzem', seconds: beforePickup - approach + pickupEnd - row.planned_pickup, driving: false },
    { label: 'Vožnja do ustanove', seconds: row.planned_dropoff - pickupEnd, driving: true },
    { label: 'Predaja in čiščenje', seconds: row.planned_end - row.planned_dropoff, driving: false },
  ].filter(phase => phase.seconds > 0);
}

export function VehicleTimeline({ state, plan, onSelect }: {
  state: State; plan: Plan | null; onSelect: (id: string) => void;
}) {
  const { horizon = 36000 } = state;
  const tasks = new Map(state.tasks.map(task => [task.id, task]));
  const risk = new Set(state.baseline.affected.map(issue => issue.task_id));
  const ticks = [...Array.from({ length: Math.ceil(horizon / 7200) }, (_, index) => index * 7200), horizon];
  const position = (seconds: number) => `${seconds / horizon * 100}%`;
  return <div className="timeline-scroll">
    <div className="timeline-grid">
      <div className="timeline-hours">
        <span>Vozilo</span>
        <div>{ticks.map(tick => <time key={tick} style={{ left: position(tick) }}>{clock(state.start_at, tick)}</time>)}</div>
      </div>
      {state.vehicles.map(vehicle => <div className="timeline-row" key={vehicle.id}>
        <strong>{vehicle.id}</strong>
        <div className="timeline-lane">
          {ticks.slice(0, -1).map(tick => <i key={tick} className="timeline-guide"
            style={{ left: position(tick) }} aria-hidden="true" />)}
          <i className="now-line" style={{ left: position(state.now) }} aria-hidden="true" />
          {plan?.assignments.filter(row => row.vehicle_id === vehicle.id).map(row => {
            const task = tasks.get(row.task_id);
            const seconds = row.planned_end - row.planned_departure;
            const phases = tripPhases(row, task?.pickup_service ?? 0);
            const range = `${clock(state.start_at, row.planned_departure)}–${clock(state.start_at, row.planned_end)}`;
            const label = [`${row.task_id} · ${range} · skupaj ${duration(seconds)}`,
              ...phases.map(phase => `${phase.label} · ${duration(phase.seconds)}`)].join('\n');
            return <button key={row.task_id} className={[
              'timeline-task', task?.priority.toLowerCase(),
              row.status === 'COMPLETED' ? 'completed' : '',
              plan.status === 'ACTIVE' && risk.has(row.task_id) ? 'risk' : '',
            ].join(' ')} style={{
              left: position(row.planned_departure), width: position(seconds),
            }} data-task-id={row.task_id} aria-label={label} title={label} onClick={() => onSelect(row.task_id)}>
              <span className="timeline-phases" aria-hidden="true">
                {phases.map(phase => <i key={phase.label} className={phase.driving ? 'driving' : 'service'}
                  style={{ width: `${phase.seconds / seconds * 100}%` }} />)}
              </span>
              <span className="timeline-task-id" aria-hidden="true">{row.task_id}</span>
            </button>;
          })}
        </div>
      </div>)}
    </div>
    {plan && <div className="timeline-legend">
      <span><i className="driving" />Vožnja</span>
      <span><i className="service" />Čakanje, prevzem in predaja</span>
    </div>}
  </div>;
}
