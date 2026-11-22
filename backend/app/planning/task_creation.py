from collections.abc import Mapping

from app.api.schemas import NewTask
from app.planning.contracts import Facility, Node, Task, TravelSnapshot


def facility_nodes(facilities: list[Facility]) -> tuple[Node, ...]:
    return tuple(Node(facility.id, "DELIVERY", facility.location) for facility in facilities)


def priority_transport(task_id: str, request: NewTask, earliest: int, facilities: list[Facility],
                       booked: Mapping[str, int], travel: TravelSnapshot) -> Task | None:
    destinations = []
    for facility in facilities:
        seconds = travel.seconds(task_id, facility.id)
        if seconds is None:
            continue
        # Keep a reachable destination even when none has room, so the planner can report the reason.
        destinations.append((not facility.accepting or booked.get(facility.id, 0) >= facility.quota,
                             not facility.accepting, seconds, travel.meters(task_id, facility.id) or 0, facility.id))
    if not destinations:
        return None
    facility_id = min(destinations)[-1]
    return Task(id=task_id, type="PRIORITY_TRANSPORT", facility_id=facility_id, earliest_pickup=earliest,
                **request.model_dump(exclude={"earliest_pickup"}))
