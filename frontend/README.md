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

Povzetek dneva je determinističen prikaz podatkov iz stanja, brez zunanjega jezikovnega modela. Zemljevid uporablja izvirni prikaz iz `main`: lokalno cestno podlago, krožne ikone vozil in ustanov, barve, ETA, sledenje in gladko premikanje. Barve časovnice in vozil so usklajene z zemljevidom. Predvajanje podpira hitrosti 30×, 60× in 300× ter premor. GPS način uporablja iste backend endpointe. Opis dodanega dogodka je neobvezen.

Časovnica uporablja polno barvo vozila za aktivne prevoze, prosojno za prihodnje, sivo za opravljene in rdečo za neuspešne oziroma blokirane. Pokvarjeno vozilo ostane v vrstici z oznako časa okvare. Spremembe med predogledom imajo zelen/oranžen obris, prejšnje dodelitve pa črtkan obris. Hover ne pošilja HTTP zahtev in ne spremeni plana v bazi. Gumb v podrobnostih naloge zapre dialog, odpre stran nalog in se pomakne do označene časovnice.

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

## Demo ura, osvežitev in potniki

Operativni zemljevid se odpre pri povečavi 13 (prej 12); kolešček miške povečuje in pomanjšuje prikaz. Velja tudi za zemljevid v dialogu dogodka.

Ročni gumb **Osveži demo in odpravi okvare** ponovno prebere stanje ter odpravi okvare vseh pokvarjenih vozil v simulaciji. Uporabi backend endpoint za popravilo, poveča revizijo in razveljavi zastarele predloge; aktivni plan ostane isti. Samodejno sledenje, navadno branje stanja in ponoven zagon strani okvar ne odpravljajo. V načinu GPS gumb samo prebere podatke.

Na časovnici je mogoče izbrati katerokoli uro demo dneva med 00:00 in 23:59, tudi pred začetkom izmene 08:00 ali po njenem koncu 18:00. Prikaz časovnice se samodejno razširi do izbrane ure; delovni razpon nalog ostane 08:00–18:00. Premik nazaj ustavi predvajanje, začne nov demo scenarij, izračuna začetni plan in ga premakne do izbrane ure. Dodani dogodki, naloge in odločitve prejšnjega scenarija se ne prenesejo v novi demo. To je ponovitev začetnega dneva, ne zgodovinski replay. Če izračun novega plana ne uspe, UI prikaže napako in omogoči ponovno generiranje.

Privzeto ima naloga enega potnika. Ena naloga lahko prepelje več potnikov z iste lokacije do istega cilja, če vozilo ustreza kapaciteti in opremi. Planer ne združuje ločenih nalog v skupno vožnjo: po prevzemu sledijo cilj, predaja in čiščenje, šele nato naslednja naloga. Test `test_group_capacity_and_sequential_transport_without_ride_pooling` preverja skupino dveh pri kapaciteti dve, zavrnitev skupine treh in neprekrivanje prevozov.

P1 z `arrival_policy=ASAP` se optimizira pred običajnimi cilji in uteženo pokritostjo drugih nalog. P2/P3 imata manjšo prednost. Novi P1 lahko po izrecni potrditvi preusmeri vozilo, ki še ni prevzelo potnika manj nujne, nezaklenjene naloge. Prevzetega potnika ne prekine; ta del poti ostane zaščiten. To preverja `test_high_priority_can_redirect_approaching_vehicle_but_keeps_picked_up_passenger`. Prioriteta je podatek dispečerja, ne avtomatska triaža; omejitve kapacitete, opreme in dosegljivosti še vedno veljajo.

## Razširitev s pravimi podatki in prodajni pitch

Raziskano 22. 11. 2026. Naslednje je predlog pilota; povezave s partnerskimi bolnišnicami in izvajalci še niso izvedene.

| Področje | Vir in potrebni podatki | Nadgradnja RescueFlow |
|---|---|---|
| Promet | NAP/Promet.si: dogodki, zapore in potovalni časi prek DATEX II; dostop do posameznega vira mora biti odobren. | OAuth2 odjemalec z obnovo žetona, preslikava lokacij na cestne povezave, smer veljavnosti, začetek/konec in izvor dogodka. |
| Bolnišnice | Dogovorjen vmesnik izvajalca za sprejemne lokacije, urnike, čakalno dobo predaje in operativno sprejemanje. | Adapter na dejanski HIS/API; kjer partner podpira FHIR, preslikava lokacij in statusov. Sprejem mora biti potrjen pri izvajalcu. |
| Reševalci in vozila | Pogodbeni izvajalec: GPS, status ekipe, oprema, posadka, izmena in odmori. | Obstoječi GPS endpoint dopolnimo z identiteto naprave/ekipe, trajnim zapisom telemetrije in modelom posadk ter izmen. |

NAP uradno objavlja profile za prometne dogodke in potovalne čase. Za B2B odjem so potrebni registracija, odobritev izbranih vsebin in OAuth2. Trenutni NAP adapter preverja informativno stanje vira; dogodkov še ne pretvarja samodejno v omejitve planerja. OSRM sam ni merilnik aktualnega prometa. [NAP profili](https://www.nap.si/sl/datexii) · [Uradna B2B navodila](https://www.nap.si/resources/doc/nap_B2B_sl.pdf)

FHIR `Location` opisuje lokacijo in njeno splošno oziroma operativno stanje; standard sam ne zagotavlja dostopa do živih bolnišničnih kapacitet. Vir, pogostost osveževanja in pomen »sprejema« določimo skupaj z bolnišnico. V pilotu demo izbiro najbližje ustanove zamenjamo s potrjenim ciljem in dogovorjenimi pravili izvajalca. [HL7 FHIR R5 Location](https://www.hl7.org/fhir/R5/location-definitions.html)

Slovenija že razvija povezane rešitve za dispečersko službo in ekipe NMP. RescueFlow bi ponudili kot integracijski modul za primerjavo razporedov ob motnjah obstoječemu izvajalcu. Predlagana povezava z obstoječim sistemom je poslovni predlog, ne že sklenjena integracija. [Ministrstvo za zdravje: IS NMP, 19. 6. 2026](https://www.gov.si/novice/2026-06-19-predstavljamo-novo-informacijsko-resitev-za-podporo-sluzbam-nujne-medicinske-pomoci-is-nmp/)

Predlagani potek: najprej zgodovinski anonimizirani podatki enega izvajalca za primerjavo rezultatov; nato vzporedni način brez pošiljanja ekip; zatem omejen pilot z dispečerjevo potrditvijo. Ob izpadu vira uporabimo zadnje veljavno stanje z vidno starostjo podatkov in možnostjo ročne koordinacije. Integracije potrebujejo nadzor dostopa, revizijsko sled, zaščito povezav, dogovor o obsegu podatkov in spremljanje napak.

Merila pilota: pokritost nalog po prioriteti, čas do prevzema P1, zamude glede na dogovorjeni rok, prazni kilometri, čas predaje, število sprememb in čas dispečerjeve odločitve. Korist izmerimo na istih vhodih proti obstoječemu postopku; vnaprej ne obljubljamo odstotka izboljšave.
