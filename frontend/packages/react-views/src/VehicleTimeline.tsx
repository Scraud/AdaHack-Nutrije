import { useState } from 'react';
import type { DispatchViewProps } from './types';
import { colorFor, equipmentLabel, formatTime, passengerOnBoard, timelineStatus, timelineBounds } from '../../contracts/plan-utils';

export function VehicleTimeline(props: DispatchViewProps) {
  const [tooltip,setTooltip]=useState<{id:string;x:number;y:number}|null>(null);
  const {start,end}=timelineBounds(props.state);
  const position=(value:string)=>Math.max(0,Math.min(100,(Date.parse(value)-start)/(end-start)*100));
  const hours=Array.from({length:Math.round((end-start)/3_600_000)+1},(_,i)=>new Date(start+i*3_600_000).toISOString());
  const now=position(props.state.simulated_time);
  const tooltipTask=props.state.tasks.find(t=>t.id===tooltip?.id);
  const tooltipAssignment=props.plan?.assignments.find(a=>a.task_id===tooltip?.id);
  return <div className="timeline-scroll"><div className="timeline-inner">
    <div className="timeline-axis"><span>VOZILO</span><div>{hours.map((time,i)=><span key={time} style={{left:`${i/(hours.length-1)*100}%`}}>{formatTime(time)}</span>)}<b className="now-label" style={{left:`${now}%`}}>{formatTime(props.state.simulated_time)}</b></div></div>
    <div className="timeline-rows">
      {props.state.vehicles.map(vehicle=>{
        const carrying=passengerOnBoard(props.state,vehicle.id);
        const broken=vehicle.status==='BROKEN';
        const breakdown=props.state.incidents.find(i=>i.incident_type==='VEHICLE_BREAKDOWN'&&i.affected_vehicle_ids.includes(vehicle.id));
        return <div key={vehicle.id} className={`timeline-row ${props.selectedVehicleId===vehicle.id?'selected':''} ${props.diff.vehicle_ids.has(vehicle.id)?'affected':''} ${carrying?'has-passenger':''} ${broken?'vehicle-broken':''}`} style={{'--vehicle-color':colorFor(vehicle.id)} as React.CSSProperties}>
        <button className="timeline-vehicle" onClick={()=>props.onSelectVehicle(vehicle.id)} aria-pressed={props.selectedVehicleId===vehicle.id} title={broken?'Vozilo je pokvarjeno':carrying?'Oseba je trenutno v vozilu':vehicle.vehicle_type}><i style={{background:broken?'#cb7467':colorFor(vehicle.id)}}/>{vehicle.code}<span>{broken?'Okvara':carrying?'V prevozu':vehicle.vehicle_type==='Prevoz z vozičkom'?'Voziček':'Sanitetno'}</span>{carrying&&<b className="passenger-indicator" aria-label="Oseba v vozilu">●</b>}</button>
        <div className="timeline-track">
          {hours.map((time,i)=><i className="timeline-gridline" key={time} style={{left:`${i/(hours.length-1)*100}%`}}/>)}
          {broken&&<span className="breakdown-region" style={{left:`${breakdown?position(breakdown.occurred_at):now}%`}}><small>Okvara {breakdown?formatTime(breakdown.occurred_at):''}</small></span>}
          {props.isPreview && props.basePlan?.assignments.filter(a=>a.vehicle_id===vehicle.id && (props.diff.changed.has(a.task_id)||props.diff.removed.has(a.task_id))).map(a=><span key={`ghost-${a.id}`} className="task-ghost" style={{left:`${position(a.planned_departure)}%`,width:`${position(a.planned_end)-position(a.planned_departure)}%`}} title={`Prejšnja dodelitev ${a.task_id}`}>{a.task_id}</span>)}
          {props.plan?.assignments.filter(a=>a.vehicle_id===vehicle.id).map(assignment=>{
            const task=props.state.tasks.find(t=>t.id===assignment.task_id);
            const state=timelineStatus(props.state,assignment);
            const added=props.diff.added.has(assignment.task_id),changed=props.diff.changed.has(assignment.task_id);
            return <button key={assignment.task_id} className={`timeline-task task-${state} ${added?'preview-added':''} ${changed?'preview-changed':''} ${props.selectedTaskId===assignment.task_id?'task-selected':''}`} style={{left:`${position(assignment.planned_departure)}%`,width:`${Math.max(1,position(assignment.planned_end)-position(assignment.planned_departure))}%`,'--vehicle-color':colorFor(vehicle.id)} as React.CSSProperties} onMouseEnter={e=>setTooltip({id:assignment.task_id,x:Math.min(window.innerWidth-310,e.currentTarget.getBoundingClientRect().left),y:e.currentTarget.getBoundingClientRect().top})} onMouseLeave={()=>setTooltip(null)} onFocus={e=>setTooltip({id:assignment.task_id,x:Math.min(window.innerWidth-310,e.currentTarget.getBoundingClientRect().left),y:e.currentTarget.getBoundingClientRect().top})} onBlur={()=>setTooltip(null)} onClick={()=>{setTooltip(null);props.onSelectTask(assignment.task_id);}} aria-label={`${assignment.task_id} · ${vehicle.code} · ${state==='failed'?'Neuspešno ali blokirano · ':''}${task?.origin.name} do ${task?.destination.name} · odhod ${formatTime(assignment.planned_departure)}, prevzem ${formatTime(assignment.planned_pickup)}, prihod ${formatTime(assignment.planned_dropoff)}, prosto ${formatTime(assignment.planned_end)}`}>
              <b className="phase-task-label">{state==='failed'?'! ':added?'+ ':''}{assignment.task_id}</b>
            </button>;
          })}
          <span className="now-line" style={{left:`${now}%`}}/>
        </div>
      </div>;})}
    </div>
    {(props.plan?.unassigned_task_ids.length ?? 0)>0&&<div className="unassigned-strip"><b>Nerazporejeno</b>{props.plan!.unassigned_task_ids.map(id=><button key={id} onClick={()=>props.onSelectTask(id)}>{id} · čaka na dodelitev</button>)}</div>}
    {props.diff.removed.size>0&&<div className="unassigned-strip"><b>Odstranjene dodelitve</b>{[...props.diff.removed].map(id=><button key={id} onClick={()=>props.onSelectTask(id)}>{id} · brez prejšnje dodelitve</button>)}</div>}
    {tooltip && tooltipTask && tooltipAssignment && <div className="task-tooltip" role="tooltip" style={{left:Math.max(8,tooltip.x),top:Math.max(8,tooltip.y-170)}}><div><b>{tooltipTask.id} · {tooltipAssignment.vehicle_id}</b><span>{tooltipTask.priority}</span></div><strong>{tooltipTask.origin.name}</strong><p>do {tooltipTask.destination.name}</p><p>Prevzem {formatTime(tooltipAssignment.planned_pickup)} · prihod {formatTime(tooltipAssignment.planned_dropoff)}</p><p>{tooltipTask.required_equipment.map(equipmentLabel).join(' · ')}</p></div>}
  </div></div>;
}
