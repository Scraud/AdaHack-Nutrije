# RescueFlow

RescueFlow je interaktivna simulacija dispečiranja naročenih in medustanovnih zdravstvenih prevozov v Ljubljani. Začetni plan in predloge izračuna OR-Tools CP-SAT. Dispečer primerja posledice motnje in izrecno potrdi novo verzijo. Vse naloge, vozila in sprejemne kvote v demu so sintetični.

## Zagon z Dockerjem

```sh
docker compose up --build
```

Odprite [dispečersko ploščo](http://127.0.0.1:8080). Nginx posreduje zahteve `/api` v FastAPI, SQLite pa se ohrani v nosilcu `rescueflow-data`. Lokalna vrata so vezana na `127.0.0.1`.

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
npm ci
npm start
```

Odprite [lokalni UI](http://127.0.0.1:4200) ali [dokumentacijo API](http://127.0.0.1:8000/docs).

## Demo in preverjanje

Odprite [scenarij predstavitve](docs/demo-scenario.md) in [pravila načrtovanja](docs/rules.md). Pokriva okvaro V3, primerjavo alternativ, odobritev nove verzije, zgodovino in primer z nezadostno kapaciteto vozil.

```powershell
Push-Location backend
..\.venv\Scripts\python.exe -m pytest
Pop-Location
Set-Location frontend
npm run build
npx playwright install chromium
npm run test:e2e
```

Playwright zažene ločeni lokalni storitvi z lastno SQLite bazo. Za preverjanje z obstoječim brskalnikom Chrome nastavite `RESCUEFLOW_TEST_BROWSER=chrome`. Če spremenite API, iz korena zaženite `.venv\Scripts\python.exe backend\export_openapi.py`, nato v `frontend` zaženite `npm run contracts`.

## Zunanji viri

Demo uporablja fiksno lokalno potovalno matriko in deluje brez ključev ali omrežja. Ploščice OpenStreetMap so izbirne. Mapa ob izpadu ploščic še vedno prikaže položaje po koordinatah. [Avtorstvo OpenStreetMap](https://www.openstreetmap.org/copyright)

»Osveži zunanje vire« preveri zadnje opazovanje postaje Ljubljana Bežigrad in ločeni povezavi do OSRM ter NAP. Vir vremenskih podatkov je ARSO. Plošča razmer uporablja te podatke informativno. [Dokumentacija ARSO](https://meteo.arso.gov.si/uploads/meteo/help/sl/xml_service.html)

OSRM potrebuje pripravljen cestni izvleček. Za prometni vir nastavite `RESCUEFLOW_NAP_URL` in veljavni `RESCUEFLOW_NAP_TOKEN` v okolju backenda ali v lokalni datoteki `.env` za Compose. NAP zahteva registracijo in dovoljenje za konkretni tok. [Priprava OSRM](routing/README.md) · [Navodila NAP za dostop](https://nap.si/resources/doc/nap_B2B_sl.pdf)

Odprto je povezovanje živih razmer s planskimi posnetki in cestnimi geometrijami v ločenem načinu LIVE. Avtoriziran klic NAP zahteva veljaven žeton.
