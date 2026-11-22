# Advisor — Consequence Explanations and Trade-off Flags

The CP-SAT planner decides *what* the best schedule is. The advisor explains *what accepting a recommendation means*: which tasks change vehicle, where the risk moves to, and which knock-on effects the dispatcher should watch. It runs fully locally: the analysis is plain Python, and the optional natural-language text comes from a local model served by [Ollama](https://ollama.com).

The advisor never changes a plan and never makes a recommendation of its own. It only explains a proposal the solver already produced.

---

## Files

| File | Purpose |
|---|---|
| `backend/app/services/advisor.py` | Deterministic analysis (`recommendation_facts`, `analyse`, `delay_exposure`) and the Ollama client (`Advisor`) |
| `backend/app/api/schemas.py` | `Explanation`, `Flag`, `TaskImpact` response models |
| `backend/app/providers/roads.py` | `path_edges()` and `segment_edges()` used to detect vehicles crossing the same jam |
| `frontend-1/.../recommendation-comparison.html` | "Pojasni posledice" button and the explanation block in each recommendation card |
| `backend/tests/test_advisor.py` | Rules-only path, shared-jam exposure, mocked Ollama (incl. hallucination guard), unreachable Ollama, stale/missing recommendation |

---

## Two Layers

```
GET /api/recommendations/{id}/explanation
        │
        ▼
recommendation_facts()  ── computed from the plans, always correct
   ├── flags        (verified warnings, sorted HIGH → MEDIUM → INFO)
   ├── impacts      (per changed task: vehicle, pickup time, delay, margin to hard deadline)
   ├── pros / cons  (rule-based, ≤ 3 each, a few words per line, e.g. "Zamuda +11 min")
   └── payload      (compact JSON: computed pros/cons, before → after metrics, disruptions)
        │
        ▼
Advisor.explain()  ── optional, local LLM via Ollama
   ├── pros         (≤ 3, ≤ 8 words each, Slovenian)
   └── cons         (≤ 3, ≤ 8 words each, Slovenian)
```

The output is designed to be read in a couple of seconds: the card shows green **+** pros and red **−** cons, and the full warning sentences are folded into a collapsed "Opozorila (N)" section.

1. **Deterministic analysis (always runs).** All numbers and warnings are computed in Python from the active plan, the proposed plan and the current conditions. Each flag has a long `message` (shown under "Opozorila") and a `short` label used for the pros/cons lists. HIGH flags always come first among the cons.
2. **Local LLM (optional).** Ollama picks the most important pros and cons from the computed ones, shortening or merging them and adding context from the active disruptions. If Ollama is not configured, not running or returns garbage, the rule-based pros/cons are shown and a `notice` says why.

The comparison baseline is the **active plan under current conditions** (the same `Baseline` the dashboard shows above the recommendation cards), not the active plan as it was originally solved.

---

## Verified Flags

| Code | Severity | When it fires |
|---|---|---|
| `UNASSIGNED` | HIGH for P1, else MEDIUM | The proposal leaves a task without a vehicle (with the reason) |
| `TIGHT_DEADLINE` | MEDIUM | A planned P2/P3 task is picked up less than 10 min before its `latest_pickup` |
| `CASCADE` | HIGH if the affected task is P1, else MEDIUM | On one vehicle, the next task has under 3 min of idle slack after the previous one **and** is either red (P1) or under 15 min from its latest pickup, so any delay on the first task carries straight into the second |
| `LATER_PICKUP` | HIGH for P1, else MEDIUM | A task waits at least 5 min longer after its desired pickup than in the active plan |
| `SHARED_DELAY_EXPOSURE` | MEDIUM for ≥2 vehicles, else INFO | Upcoming legs of several vehicles drive through the same active `TRAFFIC_DELAY` segment, so if the jam gets worse they are all delayed together |
| `FACILITY_BUNCHING` | MEDIUM for ≥3 vehicles, else INFO | Several vehicles arrive at the same facility within 5 min of each other, so a queue at handover is likely |
| `CREW_NOTICE` | INFO | Tasks move to a different vehicle, so crews must be informed |
| `RESOLVED` | INFO | The proposal executes tasks the active plan can no longer execute |

`CASCADE` suppresses `TIGHT_DEADLINE` for the same task, so one risk is not reported twice.

**Shared-jam detection:** for each non-completed assignment, the advisor rebuilds the approach leg (previous facility or vehicle start → pickup, only if the pickup is still ahead) and the loaded leg (pickup → facility) on the OSM graph under the current road effects, using `RoadNetwork.path_edges()`. It then intersects those edges with `segment_edges()` of every active traffic-delay segment. Because Dijkstra results are cached per origin, this usually takes well under a second. With OSRM plans the check still uses the OSM graph, so it is an approximation.

---

## Ollama Integration

`Advisor` calls `POST {RESCUEFLOW_OLLAMA_URL}/api/chat` with:

- `stream: false`, `temperature: 0.1`
- `format`: a JSON schema `{pros: string[≤3], cons: string[≤3]}`, so the model must return structured JSON
- a Slovenian system prompt: at most 8 words per line in bullet style, start from `computed_pros` / `computed_cons`, always list P1 risks among the cons, use only the given facts and IDs, and do not tell the dispatcher whether to accept
- the facts payload as the user message

**Payload design for small models.** Small local models are bad at arithmetic, so the payload gives them only things to choose and rephrase, never things to calculate: ready-made pros/cons lines, and metric comparisons with the direction already stated (`Zamuda: 0 min → 11 min (+11 min, poslabšanje)`).

### Guards on the model output

- **Unknown IDs:** every identifier matching `T\d+`, `V\d+` or `F\d+` must also appear in the payload; lines with unknown IDs are dropped.
- **Too long:** lines with more than 10 words are dropped.
- **Wrong side:** a line containing a metric change ("Zamuda", "Rezerva", "Vožnja" with a sign) is moved into the correct list by its sign (more reserve or less delay/driving = pro; otherwise con).
- **Missing P1 risk:** any HIGH flag the model left out is added back to the cons using its short label.
- **Empty list:** if all model cons (or pros) were dropped, the computed ones are used instead.

A `notice` tells the dispatcher when part of the model's answer was removed. Numbers in the model text are not verified individually; the full verified warnings are always available under "Opozorila".

### Caching and concurrency

- Successful LLM explanations are cached in memory per recommendation id (a proposed plan never changes). Fallback responses are not cached, so starting Ollama later works without a restart.
- A lock serialises model calls; a local model handles one request at a time anyway.
- The endpoint does not hold a database session while waiting for the model.
- The frontend does not use the global `busy` lock for this request, so the map, tracking and other controls keep working during the ~4–6 s the model needs.

### Errors

| Situation | Result |
|---|---|
| `RESCUEFLOW_OLLAMA_URL` set to empty | `source = RULES`, notice "model ni nastavljen" |
| Ollama not running | `source = RULES`, notice "Ollama ni dosegljiva na …" |
| Model not pulled (HTTP 404) | `source = RULES`, notice with `ollama pull <model>` |
| Malformed model output | `source = RULES`, notice "odgovor ni bil v pričakovani obliki" |
| Recommendation stale or decided | `409 STALE_STATE` |
| Unknown recommendation | `404 RECOMMENDATION_NOT_FOUND` |

---

## Configuration

| Variable | Default (local run) | Default (Docker Compose) |
|---|---|---|
| `RESCUEFLOW_OLLAMA_URL` | `http://127.0.0.1:11434` | `http://host.docker.internal:11434` (empty value disables the LLM) |
| `RESCUEFLOW_OLLAMA_MODEL` | `gemma3` | `gemma3` |

Setup:

```sh
ollama pull gemma3      # ~3.3 GB, 4B parameters
ollama serve            # usually already running as a background app
```

**Model choice.** `gemma3` (4B) answers in about 4–6 s on a laptop with the short pros/cons format. It sometimes picks a less important con (e.g. the jam instead of the lost reserve) because only three fit. A larger model such as `gemma3:12b` or `qwen2.5:14b` writes noticeably more accurate Slovenian, at the cost of speed and memory. Switch with `RESCUEFLOW_OLLAMA_MODEL`; no code changes are needed.

---

## Frontend

### New UI (`frontend/`)

- **Where:** "Predlagane rešitve" in `dashboard/operations-panel.component.html`. When the dispatcher pins a recommendation card (click), the expanded card shows an **"AI pregled posledic"** block under the changed tasks.
- **Rendering:** pros reuse the UI's existing `.rec-benefit` rows (check icon) and cons the `.rec-tradeoff` rows (warning icon). The only new CSS is the `.rec-insight` divider/heading in `workspace.css`, using the same palette. A small source line says "Lokalni model gemma3" or "Izračunano iz plana".
- **Data flow:** `DispatchGateway.explain?(id)` (optional, like the other backend-only methods) → `HttpDispatchGateway.explain()` calls `GET /recommendations/{id}/explanation` with a 120 s timeout, because a local model can be slow to load the first time. `DispatchStore.pin(id)` triggers `loadInsight(id)`; results are cached in the `insights` signal (`null` = failed) and `insightLoading` holds the id in flight.
- **Demo mode:** `DemoDispatchGateway` has no `explain`, so the block is hidden and no backend call is made.
- **Types:** `RecommendationInsight` in `packages/contracts/index.ts` aliases the generated `Explanation` schema.

### Original UI (`frontend-1/`)

- `DispatchStore.explain(item)` → `GET recommendations/{id}/explanation`; results are kept in the `explanations` signal (keyed by recommendation id), and `explaining` holds the id in flight.
- Each recommendation card shows a "Pojasni posledice" button. After the answer arrives it shows: green **+** pros, red **−** cons, a collapsed "Opozorila (N)" section with the full verified flags (red = HIGH, orange = MEDIUM, blue = INFO) and a source line ("Lokalni model gemma3" or "Izračunano iz plana").
