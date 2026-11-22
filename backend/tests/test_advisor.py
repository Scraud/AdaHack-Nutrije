import json

import httpx
from fastapi.testclient import TestClient

from app.main import create_app
from app.services.advisor import Advisor
from tests.test_dispatch import disruption, post, replan


def explanation(client, rec_id):
    response = client.get(f"/api/recommendations/{rec_id}/explanation")
    assert response.is_success, response.text
    return response.json()


def test_rules_only_explanation(tmp_path):
    with TestClient(create_app(tmp_path / "dispatch.sqlite", advisor=Advisor(None, "gemma3"))) as client:
        items = replan(client, disruption(client))
        result = explanation(client, items[0]["id"])
        assert result["source"] == "RULES"
        assert result["notice"]
        assert result["pros"] and result["cons"]
        assert all(len(line.split()) <= 10 for line in result["pros"] + result["cons"])
        assert len(result["pros"]) <= 3 and len(result["cons"]) <= 3
        assert all(flag["short"] for flag in result["flags"])
        codes = {flag["code"] for flag in result["flags"]}
        assert "CREW_NOTICE" in codes
        crew = next(flag for flag in result["flags"] if flag["code"] == "CREW_NOTICE")
        assert "V3" in crew["vehicle_ids"]
        severities = [flag["severity"] for flag in result["flags"]]
        assert severities == sorted(severities, key=["HIGH", "MEDIUM", "INFO"].index)
        assert {impact["task_id"] for impact in result["impacts"]} == {
            change["task_id"] for change in items[0]["plan"]["changes"]}


def test_flags_vehicles_sharing_a_traffic_jam(tmp_path):
    with TestClient(create_app(tmp_path / "dispatch.sqlite", advisor=Advisor(None, "gemma3"))) as client:
        post(client, "plans/generate")
        post(client, "demo/advance-time", {"to": 12000})
        post(client, "incidents", {"type": "TRAFFIC_DELAY", "road_id": "street:Severna obvoznica", "multiplier": 1.3})
        state = post(client, "incidents", {"type": "VEHICLE_BREAKDOWN", "vehicle_id": "V3"})
        result = explanation(client, replan(client, state)[0]["id"])
        exposure = [flag for flag in result["flags"] if flag["code"] == "SHARED_DELAY_EXPOSURE"]
        assert len(exposure) == 1 and len(exposure[0]["vehicle_ids"]) >= 2
        assert "V3" not in exposure[0]["vehicle_ids"]
        assert "Severna obvoznica" in exposure[0]["message"]


def test_ollama_narrative_drops_ungrounded_lines(tmp_path):
    requests = []

    def ollama(request: httpx.Request):
        body = json.loads(request.content)
        requests.append(body)
        facts = json.loads(body["messages"][1]["content"])
        content = {"pros": [facts["computed_pros"][0], "T99 pravočasno", "Rezerva −19 min"],
                   "cons": ["Zelo dolga alineja, ki ima precej več besed, kot jih dispečer utegne prebrati"]}
        return httpx.Response(200, json={"message": {"role": "assistant", "content": json.dumps(content)}})

    advisor = Advisor("http://ollama.test", "gemma3", transport=httpx.MockTransport(ollama))
    with TestClient(create_app(tmp_path / "dispatch.sqlite", advisor=advisor)) as client:
        items = replan(client, disruption(client))
        result = explanation(client, items[0]["id"])
        assert result["source"] == "OLLAMA" and result["model"] == "gemma3"
        assert len(result["pros"]) == 1 and "T99" not in result["pros"][0]
        assert result["cons"] == ["Rezerva −19 min"]
        assert result["notice"]
        assert requests[0]["format"]["required"] == ["pros", "cons"]
        assert explanation(client, items[0]["id"]) == result
        assert len(requests) == 1


def test_unreachable_ollama_falls_back(tmp_path):
    def down(request):
        raise httpx.ConnectError("refused", request=request)

    advisor = Advisor("http://ollama.test", "gemma3", transport=httpx.MockTransport(down))
    with TestClient(create_app(tmp_path / "dispatch.sqlite", advisor=advisor)) as client:
        items = replan(client, disruption(client))
        result = explanation(client, items[0]["id"])
        assert result["source"] == "RULES" and "Ollama" in result["notice"]


def test_stale_recommendation_is_rejected(tmp_path):
    with TestClient(create_app(tmp_path / "dispatch.sqlite", advisor=Advisor(None, "gemma3"))) as client:
        items = replan(client, disruption(client))
        post(client, "demo/advance-time", {"to": 12600})
        response = client.get(f"/api/recommendations/{items[0]['id']}/explanation")
        assert response.status_code == 409
        assert client.get("/api/recommendations/missing/explanation").status_code == 404
