import { clock, type Plan, type State } from '../../contracts';

export function VehicleTimeline({ state, plan, onSelect }: {
  state: State; plan: Plan | null; onSelect: (id: string) => void;
}) {
  const { horizon = 36000 } = state;
  const priority = new Map(state.tasks.map(task => [task.id, task.priority]));
  const risk = new Set(state.baseline.affected.map(issue => issue.task_id));
  const ticks = [0, 7200, 14400, 21600, 28800, 36000];
  return <div className="timeline-scroll">
    <div className="timeline-grid">
      <div className="timeline-hours">
        <span>Vozilo</span>
        <div>{ticks.map(tick => <span key={tick}>{clock(state.start_at, tick)}</span>)}</div>
      </div>
      {state.vehicles.map(vehicle => <div className="timeline-row" key={vehicle.id}>
        <strong>{vehicle.id}</strong>
        <div className="timeline-lane">
          <i className="now-line" style={{ left: `${(state.now / horizon) * 100}%` }} />
          {plan?.assignments.filter(row => row.vehicle_id === vehicle.id).map(row => {
            const label = `${row.task_id}, ${clock(state.start_at, row.planned_pickup)}–${clock(state.start_at, row.planned_end)}`;
            return <button key={row.task_id} className={[
              'timeline-task', priority.get(row.task_id)?.toLowerCase(),
              row.status === 'COMPLETED' ? 'completed' : '',
              plan.status === 'ACTIVE' && risk.has(row.task_id) ? 'risk' : '',
            ].join(' ')} style={{
              left: `${row.planned_departure / horizon * 100}%`,
              width: `${(row.planned_end - row.planned_departure) / horizon * 100}%`,
            }} aria-label={label} title={label} onClick={() => onSelect(row.task_id)}>
              {row.task_id}
            </button>;
          })}
        </div>
      </div>)}
    </div>
  </div>;
}
