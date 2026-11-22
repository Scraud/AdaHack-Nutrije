# Povezava z dejanskim API

Vir pogodbe so Pydantic modeli v `backend/app/api/schemas.py` in `backend/app/planning/contracts.py`. Generirani TypeScript tipi so v `packages/contracts/api.ts`. Iz korena osvežite shemo, nato iz frontenda tipe:

```powershell
.\.venv\Scripts\python.exe backend\export_openapi.py
cd frontend
npm.cmd run contracts
```

`packages/contracts/index.ts` je prikazni model, ne HTTP oblika. Pretvorbo opravi `apps/dispatcher/src/app/core/backend-adapter.ts`. API časi so sekunde od `start_at`; UI jih pretvori v ISO in prikaže v `Europe/Ljubljana`. Koordinate zahtevkov so objekti `{lat, lon}`.

| Metoda | Pot | Telo / namen |
|---|---|---|
| GET | `/api/state` | Trenutna revizija, vozila, naloge, ustanove, incidenti, aktivni plan in baseline |
| GET | `/api/recommendations` | Seznam s celotnimi kandidati, `incident_ids` in odločitvami |
| GET | `/api/plans` | Zgodovina verzij |
| GET | `/api/map/roads` | Lokalna cestna podlaga in seznam ulic iz main |
| GET | `/api/map/roads/street?name=...` | Geometrija izbrane ulice |
| GET | `/api/map/roads/nearest?lat=...&lon=...` | Najbližji cestni odsek |
| GET | `/api/tracking` | Položaji, cestne poti, ETA in aktivne cestne motnje |
| GET | `/api/tracking?plan_id=...` | Bralni cestni predogled aktualnega predloga; zastarel predlog vrne 409 |
| POST | `/api/tracking/playback` | `{playing, speed: 30|60|300}` |
| POST | `/api/incidents/:id/resolve` | `{}`; odstrani zastoj/zaporo in posodobi obvoze |
| GET / POST | `/api/conditions`, `/api/conditions/refresh` | Informativni zunanji viri |
| POST | `/api/plans/generate` | `{}`; izrecni izračun začetnega plana |
| POST | `/api/incidents` | `type`, `priority`, `description` in polja ustrezne vrste |
| POST | `/api/vehicles/:id/restore` | `{}`; odpravi okvaro, zapre odprta opozorila okvare in poveča revizijo |
| POST | `/api/recommendations/generate` | `{base_plan_id, expected_state_revision}` |
| POST | `/api/recommendations/:id/accept` | `{}`; strežnik preveri shranjeno revizijo, posnetek in omejitve |
| POST | `/api/recommendations/:id/reject` | `{reason}` |
| POST | `/api/demo/advance-time` | `{to}`; relativne sekunde, samo naprej |
| POST | `/api/demo/reset` | `{}`; nov scenarij, brez aktivnega plana |

Nova naloga ima `task: {priority, facility_id, pickup, passenger_count, equipment, earliest_pickup, preferred_arrival, latest_arrival}`. UI pošlje prioriteto tudi znotraj naloge. Okvara in nedosegljivost uporabljata `vehicle_id`, slednja še `duration` v sekundah. Vreme uporablja `location`, `duration` in `multiplier`; zastoj/zapora pošljeta izbrani `road_id`, trajanje in pri zastoju faktor časa vožnje.

Opisi in prioritete dogodkov se shranijo v JSON podatke incidentov. Kandidati vsebujejo ID-je odprtih dogodkov iz vhodnega posnetka. Ob sprejemu backend označi te dogodke kot `RESOLVED` in zapiše `selected_recommendation_id` ter `resolved_at`. To pomeni obdelano plansko odločitev: fizična motnja še velja do svojega izteka oziroma po pravilih simulacije. Zgodovina odločitev se bere iz predlogov tudi po spremembi revizije.

Po mutaciji gateway prebere stanje, predloge in zgodovino. UI prikaže največ tri predloge `PROPOSED` s trenutno revizijo in planom, statusom solverja `FEASIBLE`/`OPTIMAL` in brez blokad. Prazna množica ne pomeni dokazane neizvedljivosti. Predogled deluje lokalno; šele accept aktivira plan v SQLite transakciji.

API napake imajo FastAPI `detail`; strukturirani odgovor vsebuje `code` in `message`. HTTP 409 ne spremeni plana in zahteva osvežitev oziroma nov izračun. Analitika v `analysis/mock-analytics.ts` je prikazna in ni del API ali optimizacijskih vhodov.
