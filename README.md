# RescueFlow

RescueFlow je interaktivna simulacija dispečiranja naročenih in medustanovnih zdravstvenih prevozov v Ljubljani. Začetni plan in predloge izračuna OR-Tools CP-SAT. Dispečer primerja posledice motnje in izrecno potrdi novo verzijo. Vse naloge, vozila in sprejemne kvote v demu so sintetični.

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

## Zemljevid in sledenje

Zemljevid uporablja lokalni izsek cest OpenStreetMap za Ljubljano. Polna črta vodi do pacienta, pikčasta do ciljne ustanove. Barva poti se ujema z oznako vozila. Za zastoj ali zaporo v panelu **Motnje** napišite ime ulice oziroma jo izberite s seznama ali vklopite izbiro in kliknite cesto na zemljevidu. Aktivne zastoje in zapore lahko v istem panelu ročno odstranite. Načrtovanje upošteva motnjo na izbranih povezavah, simulirana vozila pa samodejno poiščejo obvoz in osvežijo predvidene čase. Obvoz ne spremeni dispečerjeve izbire vozila ali vrstnega reda nalog; če poti ni mogoče najti, ostane naloga označena za ročno koordinacijo. Lokacija prevzema po prevzemu pacienta izgine z zemljevida.

Po ustvarjanju plana kliknite **Predvajaj 60×** ali **300×**. Zadnja prejeta simulirana lokacija se osveži vsako sekundo. Nad vozilom je predviden čas do pacienta, po prihodu na prevzem pa do ciljne ustanove. Časovnica uporablja isto časovno merilo za vsa vozila in prikazuje vožnjo ter čakanje, prevzem in predajo z različnimi odtenki. Motnja, premik ure ali ponovni izračun ustavi predvajanje. [Izvor in obnovitev cestnega izseka](routing/README.md)

Med osvežitvami se vozilo gladko premika po narisani poti, že prevoženi del črte pa se sproti briše. [Gladko premikanje in samodejni obvozi](docs/vehicle-motion.md)

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

Zemljevid in planer privzeto uporabljata priloženo cestno omrežje Ljubljane. Demo deluje brez ključev in zunanjih zemljevidnih ploščic. Za izračun z regionalnim cestnim omrežjem lahko vključite lokalni OSRM. [Priprava lokalnega OSRM](routing/README.md) · [Avtorstvo OpenStreetMap](https://www.openstreetmap.org/copyright)

»Osveži zunanje vire« preveri zadnje opazovanje postaje Ljubljana Bežigrad in ločeni povezavi do OSRM ter NAP. Vir vremenskih podatkov je ARSO. Plošča razmer uporablja te podatke informativno. [Dokumentacija ARSO](https://meteo.arso.gov.si/uploads/meteo/help/sl/xml_service.html)

OSRM potrebuje pripravljen cestni izvleček. Za prometni vir nastavite `RESCUEFLOW_NAP_URL` in veljavni `RESCUEFLOW_NAP_TOKEN` v okolju backenda ali v lokalni datoteki `.env` za Compose. NAP zahteva registracijo in dovoljenje za konkretni tok. [Priprava OSRM](routing/README.md) · [Navodila NAP za dostop](https://nap.si/resources/doc/nap_B2B_sl.pdf)

Prometni in vremenski viri na plošči so informativni. Simulirane motnje še vedno vplivajo na plansko matriko.
