# RescueFlow

RescueFlow je interaktivna simulacija dispečiranja naročenih in medustanovnih zdravstvenih prevozov v Ljubljani. Začetni plan in predloge izračuna OR-Tools CP-SAT. Dispečer primerja posledice motnje in izrecno potrdi novo verzijo. Vse naloge, vozila in sprejemne kvote v demu so sintetični.

Aktivni uporabniški vmesnik je v `frontend/`: Domov, Naloge, Vozila, Dogodki in Analiza. Prejšnji vmesnik iz `main` je ohranjen v `frontend-1/`. [Navodila novega frontenda](frontend/README.md) vključujejo opis strani, povezave z API in integracijskega preverjanja. Analiza uporablja izrecno označene vzorčne podatke za 24-urni forecast in heatmape celotne Slovenije; operativne strani uporabljajo backend.

## Zagon z Dockerjem

```sh
docker compose up --build
```

Odprite [dispečersko ploščo](http://127.0.0.1:8080). Nginx posreduje zahteve `/api` v FastAPI, SQLite pa se ohrani v nosilcu `rescueflow-data`. Lokalna vrata so vezana na `127.0.0.1` in jih lahko nastavite z `RESCUEFLOW_PORT`.

## Lokalni zagon brez Dockerja

Potrebujete Python 3.12 ali novejši in Node 24 ali Node 22.12 ali novejši v veji 22. Prvi terminal na Windows zažene backend.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e '.\backend[test]'
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --port 8000
```

Na Linuxu ali macOS uporabite `.venv/bin/python` ter pot `./backend[test]`. Drugi terminal zažene frontend.

```sh
cd frontend
npm.cmd ci
npm.cmd start
```

Odprite [lokalni UI](http://127.0.0.1:4200) ali [dokumentacijo API](http://127.0.0.1:8000/docs).

Kliknite **Pripravi demo 11:20**, nato **Simuliraj dogodek**. Po dodajanju dogodka v stranskem panelu primerjajte razpoložljive predloge, enega pripnite in potrdite. Aktivni plan se spremeni šele ob potrditvi.

## Demo in preverjanje

Odprite [scenarij predstavitve](docs/demo-scenario.md) in [pravila načrtovanja](docs/rules.md). Pokriva okvaro V3, primerjavo alternativ, odobritev nove verzije, zgodovino in primer z nezadostno kapaciteto vozil.

```powershell
Push-Location backend
..\.venv\Scripts\python.exe -m pytest
Pop-Location
Set-Location frontend
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

Integracijski preizkus novega UI uporablja pravi HTTP gateway in ločeno SQLite bazo; natančni ukazi so v [frontend/README.md](frontend/README.md#preverjanje). Prejšnji Playwright testi ostajajo skupaj s prejšnjim vmesnikom v `frontend-1/`. Če spremenite API, iz korena zaženite `.venv\Scripts\python.exe backend\export_openapi.py`, nato v `frontend` zaženite `npm.cmd run contracts`.

## Zemljevid in sledenje

Backend za načrtovanje uporablja lokalni izsek cest OpenStreetMap za Ljubljano. Novi UI prikazuje Leaflet podlago in jasno označene približne povezave med dodelitvami. Barve vozil so usklajene z njihovo časovnico. Pri dodajanju zastoja ali zapore pošljete točko, backend pa poišče najbližji konfigurirani cestni odsek.

Simulirani čas v novem UI premikate z uro ob časovnici. GPS in samodejno predvajanje sta podprta v dodatnih backend endpointih ter ohranjenem starem UI; novi UI ju trenutno ne prikazuje. [Izvor in obnovitev cestnega izseka](routing/README.md)

Za povezavo GPS nastavite `RESCUEFLOW_GPS_KEY` v okolju backenda oziroma v `.env` za Compose in ponovno zaženite backend. GPS odjemalec pošlje `POST /api/tracking/gps` z glavo `Authorization: Bearer <ključ>`. Telo zahtevka vsebuje ID vozila, položaj in čas meritve z odmikom ali UTC.

```json
{
  "vehicle_id": "V1",
  "location": { "lat": 46.064, "lon": 14.515 },
  "recorded_at": "2026-11-21T10:20:00Z"
}
```

GPS odjemalec uporabi čas dejanske meritve. V načinu GPS zemljevid označi lokacije, starejše od 15 sekund, kot zastarele. Backend v pomnilniku hrani zadnjo lokacijo posameznega vozila. Ta način prikazuje telemetrijo, medtem ko tabela in planer ostaneta namenjena sintetičnemu scenariju.

## Zunanji viri

Planer deluje brez ključev. Novi Leaflet UI uporablja zunanje OpenStreetMap ploščice z lokalno shemo kot alternativo. [Avtorstvo OpenStreetMap](https://www.openstreetmap.org/copyright)

Backend ima tudi informativne zunanje vire za zadnje opazovanje postaje Ljubljana Bežigrad ter povezavi do OSRM in NAP. Novi UI teh podatkov ne meša s simulacijami vremena. Vir vremenskih podatkov je ARSO. [Dokumentacija ARSO](https://meteo.arso.gov.si/uploads/meteo/help/sl/xml_service.html)

OSRM potrebuje pripravljen cestni izvleček. Za prometni vir nastavite `RESCUEFLOW_NAP_URL` in veljavni `RESCUEFLOW_NAP_TOKEN` v okolju backenda ali v lokalni datoteki `.env` za Compose. NAP zahteva registracijo in dovoljenje za konkretni tok. [Priprava OSRM](routing/README.md) · [Navodila NAP za dostop](https://nap.si/resources/doc/nap_B2B_sl.pdf)

Odprto je povezovanje živih razmer s planskimi posnetki in cestnimi geometrijami v ločenem načinu LIVE. Avtoriziran klic NAP zahteva veljaven žeton.
