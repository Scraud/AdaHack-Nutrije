from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from app.main import create_app


def create(client, hours):
    state = client.get("/api/state").json()
    payload = {"scheduled_at": (datetime.fromisoformat(state["start_at"]) + timedelta(hours=hours)).isoformat(),
               "pickup": state["tasks"][0]["pickup"], "pickup_name": "Ljubljana – prevzem",
               "facility_id": "F1", "equipment": ["STRETCHER"]}
    response = client.post("/api/tasks", json=payload)
    assert response.is_success, response.text
    return response.json()


def test_future_task_persists_without_affecting_active_routes_then_enters_window_once(tmp_path):
    path = tmp_path / "scheduled.sqlite"
    with TestClient(create_app(path)) as client:
        initial = client.post("/api/plans/generate").json()
        future = create(client, 25)
        task_id = future["scheduled_tasks"][0]["id"]
        assert len(future["tasks"]) == 20
        assert future["revision"] == initial["revision"]
        assert future["active_plan"] == initial["active_plan"]
        assert future["incidents"] == []
    with TestClient(create_app(path)) as client:
        assert client.get("/api/state").json()["scheduled_tasks"][0]["id"] == task_id
        before = client.post("/api/demo/clock", json={"to": 3599}).json()
        assert len(before["scheduled_tasks"]) == 1
        due = client.post("/api/demo/clock", json={"to": 3600}).json()
        assert due["scheduled_tasks"] == []
        assert any(task["id"] == task_id for task in due["tasks"])
        assert len([i for i in due["incidents"] if i["task_id"] == task_id]) == 1
        later = client.post("/api/demo/clock", json={"to": 3601}).json()
        assert len([i for i in later["incidents"] if i["task_id"] == task_id]) == 1
        assert due["horizon"] > 25 * 3600
        response = client.post("/api/recommendations/generate", json={
            "base_plan_id": later["active_plan"]["id"], "expected_state_revision": later["revision"]})
        assert response.is_success, response.text
        candidates = response.json()["items"]
        assert candidates
        chosen = next(rec for rec in candidates if any(a["task_id"] == task_id for a in rec["plan"]["assignments"]))
        accepted = client.post(f"/api/recommendations/{chosen['id']}/accept", json={})
        assert accepted.is_success, accepted.text
        assert next(a for a in chosen["plan"]["assignments"] if a["task_id"] == task_id)["planned_pickup"] >= 25 * 3600


def test_exactly_24_hours_is_eligible_and_past_or_naive_dates_are_rejected(tmp_path):
    with TestClient(create_app(tmp_path / "boundary.sqlite")) as client:
        eligible = create(client, 24)
        assert eligible["scheduled_tasks"] == []
        assert len(eligible["tasks"]) == 21
        assert len(eligible["incidents"]) == 1
        payload = {"pickup": {"lat": 46.05, "lon": 14.51}, "pickup_name": "Prevzem", "facility_id": "F1"}
        assert client.post("/api/tasks", json={**payload,"scheduled_at": "2026-11-21T06:00:00Z"}).status_code == 400
        assert client.post("/api/tasks", json={**payload,"scheduled_at": "2026-11-22T10:00:00"}).status_code == 422
        late = client.post("/api/demo/clock", json={"to": 15 * 3600})
        assert late.is_success, late.text
        unavailable = client.post("/api/incidents", json={"type": "VEHICLE_UNAVAILABLE", "vehicle_id": "V1", "duration": 1800})
        assert unavailable.is_success, unavailable.text
        vehicle = next(v for v in unavailable.json()["vehicles"] if v["id"] == "V1")
        assert vehicle["unavailable"][-1] == [15 * 3600, 15 * 3600 + 1800]
