# Predlagana pogodba za povezavo frontenda

To je dogovor, pripravljen za razvijalca zaledja; ob pisanju backend še ni bil v repozitoriju. Kanonične oblike so v `packages/contracts/index.ts`. Vsi ID-ji so nizi. Časi so ISO 8601 z UTC odmikom; UI jih prikazuje v `Europe/Ljubljana`. Imena atributov uporabljajo `snake_case`.

## Klici

| Metoda | Pot | Telo / odziv |
|---|---|---|
| GET | `/api/state` | `DispatchState` s celotnim `active_plan` ali `null`, vozili, nalogami, ustanovami, incidenti in odločitvami |
| GET | `/api/recommendations` | `Recommendation[]`, vsak s celotnim `proposed_plan` |
| POST | `/api/plans/generate` | `{}`; uporabnikov izrecen ukaz za začetni plan |
| POST | `/api/incidents` | `{ incident_type: "NEW_TASK", priority: "P1", scenario: "priority_transport_1120" }` |
| POST | `/api/recommendations/generate` | `{ incident_id, base_plan_id, expected_state_revision }` |
| POST | `/api/recommendations/:id/accept` | `{ base_plan_id, expected_state_revision }` |
| POST | `/api/recommendations/:id/reject` | `{ reason, expected_state_revision }` |
| POST | `/api/demo/reset` | `{}` |

Po vsaki uspešni mutaciji frontend ponovno prebere stanje in predloge. Telo uspešnega POST odgovora je lahko poljuben JSON ali HTTP 204. Dolgotrajnejši asinhroni izračun z job ID-jem zahteva manjšo razširitev adapterja; trenutna pogodba čaka na zaključen POST (timeout 30 sekund).

HTTP 409 pomeni zastarelo verzijo ali revizijo: brez aktivacije, s pozivom k osvežitvi. Napake naj vrnejo `{ "detail": "Slovensko pojasnilo" }`.

## Ključna polja

`DispatchState`: `scenario_id`, `state_revision`, `simulated_time`, `horizon_start`, `horizon_end`, `mode`, `vehicles[]`, `facilities[]`, `tasks[]`, `active_plan`, `incidents[]`, `decisions[]`. `recommendations` v stanju ni treba vključiti, ker se preberejo z ločenim GET klicem.

`DispatchPlan`: `id`, `version`, `status`, `assignments[]`, `unassigned_task_ids[]`, opcijsko `routes[]` in `metrics.remaining_buffer_minutes`. Če rezerva ni izračunana, naj polje manjka; UI pokaže pomišljaj.

`Assignment`: `id`, `task_id`, `vehicle_id`, `sequence_order`, `planned_departure`, `planned_pickup`, `planned_dropoff`, `planned_end`, `status`, `is_locked`.

`Recommendation`: `id`, `incident_id`, `base_plan_id`, `base_state_revision`, `strategy`, `status`, `title`, `explanation`, `trade_off`, `feasibility_reasons[]`, `proposed_plan`, `solver_status`. Prikazani so samo predlogi `PROPOSED`, ki ustrezajo aktivnemu planu in reviziji ter imajo `solver_status: "FEASIBLE"` ali `"OPTIMAL"`. Polja `is_fixture` ne uporabljajte za rezultate backenda. Ni samodejne oznake »najboljši«.

`TransportTask` uporablja `origin` in `destination` v obliki `{ lat, lon, name }`. Če vaš backend uporablja `pickup_lat`, `dropoff_lat` itd., pretvorbo opravite v `HttpDispatchGateway.getState()`. Enako velja za `Vehicle.location_name`, `Facility.short_name`, naslove incidentov in povezane sezname ID-jev.

## Geometrije

```json
{
  "vehicle_id": "V1",
  "source": "OSRM",
  "coordinates": [[14.5176, 46.0560], [14.5257, 46.0545]]
}
```

Koordinate so v GeoJSON vrstnem redu **[longitude, latitude]**. Geometrija mora pripadati dodelitvam istega plana. Brez nje UI iz dodelitev sestavi približne črtkane povezave in jih tako tudi označi. Vzorca zgoraj ne uporabite kot dejansko cestno geometrijo.

## Odgovornosti backenda

- Ob generiranju vrne samo različne, validirane kandidate in dejanske metrike/razloge; iztek časa ni dokaz neizvedljivosti.
- Sprejem atomarno preveri `base_plan_id`, revizijo in veljavnost vhodnega posnetka; shrani odločitev, spremeni aktivni plan in status incidenta.
- Zaščitene dodelitve in klinično določena prioriteta/cilj ostanejo nespremenjeni po dogovorjenih pravilih.
- Reset razveljavi stare predloge in vrne deterministično stanje. Frontend nima neposrednega dostopa do baze ali poverilnic.
- Razvojni proxy omogoča isti izvor. Če nastavite drug `apiBaseUrl`, mora backend pravilno dovoliti CORS in uporabljene poverilnice.
