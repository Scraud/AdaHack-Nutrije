# RescueFlow frontend

Samostojen slovenski dispečerski vmesnik v mapi `frontend/`. Backend, baza in optimizator niso del te implementacije in niso bili spreminjani.

## Zagon

Potrebujete Node.js 22.12 ali novejši znotraj veje 22 (ali združljiv Node 24) ter npm.

```powershell
cd AdaHack-Nutrije/frontend
npm.cmd ci
npm.cmd start
```

Odprite **http://127.0.0.1:4200**. Na sistemih brez PowerShell omejitve skript lahko uporabite tudi `npm ci` in `npm start`.

```powershell
npm.cmd run build
npm.cmd run typecheck
npm.cmd test
```

Produkcijske datoteke so v `dist/dispatcher/browser/`. Aplikacijo servirajte prek HTTP; odpiranje `index.html` prek `file://` ni podprto.

## Kaj je vključeno

- Pregled: KPI iz stanja, razširljive kartice petih vozil, Leaflet zemljevid Ljubljane in React časovnica.
- Enoten izbor vozila na zemljevidu, v floti in na časovnici; podrobnosti nalog.
- Pomočnik: predogled ob prehodu kazalca ali fokusu, pripenjanje s klikom, primerjava sprememb in izrecna potrditev v modalnem oknu.
- Ločena stran dogodkov z iskanjem, filtri, podrobnostmi in zgodovino odločitev; pregled flote.
- Nalaganje, napake, ponovni poskus, prazna stanja in ponastavitev.
- Mobilna postavitev, tipkovnica, native dialog fokus in podpora zmanjšanemu gibanju.

## Vir podatkov in povezava z backendom

Privzeti `public/config.json`:

```json
{ "dataSource": "demo", "apiBaseUrl": "/api" }
```

Način `demo` uporablja **izključno vzorčne podatke za UI**. Trije predlogi so vnaprej pripravljene ilustracije interakcij in niso rezultati optimizatorja. To je označeno tudi v vmesniku. Podatki so v pomnilniku; osvežitev strani začne nov prikaz. Ni optimizacije, baze, cestnega usmerjanja ali samodejnega kliničnega odločanja.

Za pravo povezavo spremenite `dataSource` v `api`. Razvojni proxy v `proxy.conf.json` preusmeri `/api/**` na `http://127.0.0.1:8000`. V produkciji lahko `config.json` zamenjate brez ponovne gradnje. API način se ob napaki **ne preklopi na vzorčne podatke**.

Podrobnosti dogovora za backend: [API_CONTRACT.md](./API_CONTRACT.md). TypeScript modeli so v `packages/contracts/index.ts`, vsi HTTP klici pa v `apps/dispatcher/src/app/core/dispatch-api.ts`. Ker backend še ni na voljo, je to predlagana pogodba, ne generirana OpenAPI shema. Ko bo backend pripravljen, prilagodite samo HTTP adapter in pogodbe ali jih generirajte iz njegove sheme.

## Struktura

```text
apps/dispatcher/src/app/
  core/               Angular signal stanje, HTTP adapter in ločeni UI fixtures
  dashboard/          kartice vozil
  incidents/          ločena stran dogodkov
  recommendations/    pomočnik in primerjava predlogov
  react-host/         Angular mount/update/unmount ovoj
  shared/             ikone
  app.component.*     navigacija, pregled in dialogi
packages/
  contracts/          skupni tipi, prikazne metrike in primerjava planov
  react-views/src/    DispatchMap, VehicleTimeline in lifecycle API
tests/                testi predogleda, potrditve, zastarelosti in reseta
```

Angular je edini lastnik aplikacijskega stanja in API zahtev. React prejema `displayedPlan = previewPlan ?? activePlan`, skupni `selectedVehicleId` in callbacke. Hover ne pošilja HTTP zahtev in ne spreminja aktivnega plana.

## Zemljevid in omejitve

Izgled Leafleta je zbran v `packages/react-views/src/map.css`, oznake in kontrole pa v `packages/react-views/src/DispatchMap.tsx`. V meniju **Plasti in izgled** lahko izbirate med umirjeno in izvirno ulično podlago ter vključite poti in ustanove. Oba sloga uporabljata iste OpenStreetMap ploščice; umirjen slog spremeni njihov prikaz s CSS filtrom. Dodatna storitev, ključ ali odvisnost niso potrebni. Barve vozil so skupne zemljevidu in časovnici (`packages/contracts/plan-utils.ts`). Izbor vozila poudari njegovo pot, pokaže kartico s statusom in prilagodi območje prikaza. Gumb za prikaz celotne flote uporabi dejanske koordinate prikazanih vozil in dodelitev.

OpenStreetMap ploščice in Google Fonts potrebujejo internet. Brez povezave ostaneta lokalna, jasno označena shema in sistemska pisava. Približne črtkane povezave nastanejo iz istih dodelitev kot časovnica in so označene kot **približne povezave, ne cestne poti**. Če backend vrne `routes` z `source: "OSRM"`, se uporabijo njegove geometrije. OSRM tu ne pomeni živih prometnih podatkov. Pri uporabi ploščic v večjem obsegu upoštevajte politiko ponudnika oziroma nastavite svoj vir.

Frontend opravi osnovna prikazna preverjanja kandidata (podvojitve, časi, prekrivanja, zaščitene dodelitve). Celotna validacija opreme, časov vožnje, kapacitete in ostalih omejitev je odgovornost backenda. Samo backend potrdi izvedljivost in atomarno aktivira plan.

Dodana sta Dockerfile in nginx proxy za prihodnjo integracijo. Docker build ni bil preverjen v tej izvedbi; skupni Compose ni bil spreminjan. Osveževanje podatkov je trenutno ob zagonu, uporabnikovem ponovnem poskusu in po mutacijah; polling ali WebSocket lahko doda backend integracija.

## Preverjanje izvedbe

Produkcijski build, TypeScript preverjanje in 10 avtomatiziranih testov stanja so uspešno opravili preverjanje. Lokalni razvojni strežnik je vrnil HTTP 200. Vizualno preverjanje v brskalniku ni bilo dokončano: orodje za upravljanje Chroma je ustavilo dostop, ker ni moglo zanesljivo določiti trenutnega URL-ja. Preverjanje s pravim backendom in Dockerjem še čaka na integracijo.
