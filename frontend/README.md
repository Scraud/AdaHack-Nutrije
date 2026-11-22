# RescueFlow frontend

Slovenski dispečerski UI v mapi `frontend/`, povezan s FastAPI backendom in njegovo SQLite bazo. Prejšnji vmesnik iz `main` je ohranjen v `frontend-1/`. Angular upravlja stanje in HTTP, React izriše Leaflet zemljevid in časovnico.

## Zagon na Windows

V prvem terminalu, iz korena repozitorija:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e '.\backend[test]'
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

V drugem terminalu, iz korena repozitorija:

```powershell
cd frontend
npm.cmd ci
npm.cmd start
```

Odprite **http://127.0.0.1:4200**. Za razvoj uporabite Node 22.12+ v veji 22 ali združljiv Node 24. Ob prvem zagonu kliknite **Pripravi demo 11:20**: backend izračuna začetni plan in premakne simulacijo. Nato izberite **Simuliraj dogodek**, preglejte podatke in dodajte dogodek. Predloge primerjajte s kazalcem oziroma tipkovnico, enega pripnite in izrecno potrdite.

Iz korena je na voljo tudi `docker compose up --build` in UI na http://127.0.0.1:8080. Dockerfile, nginx in Compose konfiguracija so ohranjeni iz `main`. Preverjeni so Compose konfiguracija, gradnja frontend Docker slike, nginx ter HTTP dostop do strani, JavaScript paketa in `config.json`. Celoten Compose deployment z backendom v tem preverjanju ni bil zagnan.

## Strani

- **Domov:** zemljevid čez celotno širino strani, zložljiva opozorila s prioritetami in razvrščanjem, samodejni povzetek, operativni KPI ter časovnica. Brez opozoril je panel zaprt; gumb Opozorila ga odpre ali pospravi. Za vsak dogodek je eno obvestilo. Klik odpre velik modal z zemljevidom, časovnico in največ tremi rešitvami na desni; hover/fokus posodobi oba predogleda.
- **Naloge:** iskanje, filtri, nerazporejene/ogrožene naloge, podrobnosti in povezava s časovnico. Nepotrjene naloge in spremembe so označene z rdečim opozorilom »Čaka na potrditev«.
- **Vozila:** oprema, lokacija, status, zasedenost, prosti čas in naloge; preostali čas do prevzema in do bolnišnice po aktivnem razporedu; prijava okvare ali nedosegljivosti z razlogom in trajanjem. Gumb **Odpravi okvaro** shrani popravilo, razveljavi stare predloge in omogoči nove dodelitve ob naslednjem izračunu; aktivni plan se ob popravilu ne zamenja samodejno.
- **Dogodki:** seznam, filtri in dodajanje; podrobnosti odprejo stranski pregled na domači strani, skupaj z zgodovino odločitev.
- **Analiza:** jasno označeni **vzorčni podatki** za teden/mesec/leto, 24-urna napoved povpraševanja, časovna heatmapa 00–23 in zemljevid obremenitve celotne Slovenije ter primerjava vozil. Ti podatki ne vplivajo na planer in niso zgodovina baze.

Povzetek dneva je determinističen prikaz podatkov iz stanja, brez zunanjega jezikovnega modela. Zemljevid uporablja lokalno cestno podlago, krožne ikone vozil in ustanov, barve, ETA, sledenje in gladko premikanje. Ikona vozila ima na časovnici isto barvo kot na zemljevidu. Predvajanje podpira hitrosti 30×, 60× in 300× ter premor. GPS način uporablja iste backend endpointe. Opis dodanega dogodka je neobvezen.

Časovnica obarva naloge po prioriteti. Visoka je rdeča, srednja oranžna in nizka zelena. Na glavni strani in v predogledu predloga premik kazalca ali fokus na nalogo pokaže želeni in napovedani prihod iz prikazanega plana. Pri visoki prednostni nalogi je želeni prihod označen s »Čim prej«. Pokvarjeno vozilo ostane v vrstici z oznako časa okvare. Nove in spremenjene dodelitve so v predogledu poudarjene z obrisom. Gumb v podrobnostih naloge zapre dialog, odpre stran nalog in se pomakne do označene časovnice.

## Povezava z backendom

`public/config.json` je privzeto nastavljen na pravi API:

```json
{ "dataSource": "api", "apiBaseUrl": "/api" }
```

Razvojni proxy preusmeri `/api` na `127.0.0.1:8000`; nginx v Dockerju na storitev backend. Ob napaki povezave aplikacija pokaže napako. Sledenje osvežuje vsako sekundo; sprememba revizije osveži tudi stanje in razveljavi stare predoglede. Ločeni `dataSource: "demo"` je namenjen starim UI fixtures in testom, ne celotnemu integriranemu demu.

Backend vrne do tri različne kandidate. UI pokaže samo aktualne potrdivne možnosti, blokade pa posebej. Ne ustvarja nadomestnih predlogov. Revizije, izvedljivost in atomaren sprejem preveri backend.

Generirani tipi dejanske OpenAPI sheme so v `packages/contracts/api.ts`. `core/backend-adapter.ts` pretvori relativne sekunde v ISO čase in dejanske API podatke v prikazne modele. HTTP klici so zbrani v `core/dispatch-api.ts`. Podrobnosti: [API_CONTRACT.md](API_CONTRACT.md).

## Preverjanje

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

Produkcijski rezultat je v `dist/dispatcher/browser/`; potrebuje HTTP strežnik. Videz je urejen v `apps/dispatcher/src/workspace.css`, mapa v `packages/react-views/src/map.css`.

Integracijski preizkus izvaja reset, zato uporabite **ločeno testno bazo**. V prvem terminalu iz korena:

```powershell
$env:RESCUEFLOW_DB="$PWD\ui-integration.sqlite"
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8001
```

V drugem, iz `frontend/`:

```powershell
$env:RESCUEFLOW_TEST_API='http://127.0.0.1:8001/api'
npm.cmd run test:integration
```

Preizkus pokrije pripravo dneva, nov prevoz, izolacijo predogleda, potrditev, zgodovino, vreme, okvaro, zavrnitev, nedosegljivost in reset. Standardni backend testi ostanejo v `backend/tests`.

Za ločen razvojni predogled tega testnega backenda lahko uporabite `npm.cmd start -- --port 4201 --proxy-config tests/integration/proxy.json`.

Če je bil `ng serve` odprt med preimenovanjem oziroma dodajanjem datotek analize in še prikazuje »Cannot find module«, ga ustavite s Ctrl+C ter ponovno zaženite `npm.cmd start`. Ob dodajanju novega API endpointa ponovno zaženite tudi backend, če ne uporablja `--reload`.

## Zemljevid

Operativni zemljevid prikazuje lokalno cestno omrežje iz `main` brez zunanjih ploščic. Polna pot vodi do pacienta, pikčasta do ustanove; položaji in ETA prihajajo iz `/api/tracking`. Že prevoženi del poti se sproti umika. Zemljevid ostane čez razpoložljivo širino in je enak tudi v pregledu rešitev ter izbiri cestnega dogodka. Statistični zemljevid Slovenije ostaja ločen prikaz vzorčnih podatkov.

V meniju **Simuliraj dogodek** izberite **Prometni zastoj** ali **Zapora ceste**. Ulico poiščite po imenu ali vključite **Izberi na zemljevidu** in kliknite cestni odsek. Izbor je označen oranžno; aktivne motnje se prikažejo rdeče. Privzeti zastoj uporablja parametre iz `main`: faktor **2,3** in trajanje **90 minut**. Backend iz `main` izračuna obvoz in posodobi čase ob ohranjeni dodelitvi vozila. V pregledu dogodka gumb **Odstrani zastoj/zaporo** ponovno sprosti odsek. Obravnavana odločitev in fizično odstranjena motnja sta ločeni stanji.

Cestni predogledi največ treh rešitev se vnaprej preberejo prek `/api/tracking?plan_id=...`; uporabljajo iste cestne funkcije iz `main` in ne spreminjajo baze ali aktivnega plana. Prehod s kazalcem nato samo izbere že naloženo geometrijo in pripadajočo časovnico. Plan aktivira šele izrecna potrditev.
