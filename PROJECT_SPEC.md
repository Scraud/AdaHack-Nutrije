# Rescue+ — specifikacija projekta za AdaHack / Epilog

> **Delovno ime:** Rescue+\
> **Uporabnik:** dispečer zdravstvenih prevozov  
> **Tip projekta:** interaktivni prototip in simulacija, ne produkcijski sistem za nujno medicinsko pomoč  
> **Glavna ideja:** robustno razporejanje vozil in odločanje ob motnjah

## 1. Problem in cilj

Dispečer razporeja omejeno število vozil, posadk in opreme med prevozne naloge. Upoštevati mora lokacije, razpoložljivost vozil, ustrezno opremo, časovna okna, prednost nalog, trajanje prevzema in predaje ter stanje na cestah. Ko se zgodi okvara, zastoj, nova naloga ali druga motnja, prvotni razpored morda ni več izvedljiv.

**Cilj rešitve:** sistem pripravi začetni izvedljiv načrt; prikaže vozila, naloge in stanje razporeda; zazna ali simulira motnjo; izračuna **več izvedljivih alternativ** ter jasno razloži posledice. Dispečer lahko predlog sprejme, zavrne ali ročno spremeni dodelitev. Sistem nikoli ne spreminja klinične prioritete ali ciljne ustanove brez pristojnega uporabnika.

**Glavna prodajna vrednost:** ne optimiziramo samo poti, ampak **odpornost urnika na nepredvidene dogodke** (*robust scheduling + dynamic routing*).

### Natančen obseg MVP-ja

- Primarno **naročeni in nenujni zdravstveni prevozi** ter medustanovni prevozi.
- Podpora **naknadno dodani visoko prioritetni nalogi**, katere prioriteto in medicinske zahteve je **že določil pristojen človek**; brez algoritmične triaže.
- Ob dogodku načrt **ponovno izračunamo**, vendar ne spreminjamo opravljenih, že začetih ali izrecno zaklenjenih dodelitev.
- Realistični, vendar **sintetični podatki** za 5 vozil, 15–20 nalog in 3–4 ustanove na območju Ljubljane. Podatki o kapacitetah ustanov so izključno simulirani.
- **Brez integracije s 112**, brez realnih pacientov, brez dejanskega pošiljanja vozil in brez samodejnega odločanja o zdravljenju.

### Vloge

| Vloga | Naloga | Kaj pridobi |
|---|---|---|
| Dispečer — glavni uporabnik | Pregleda plan, dodaja dogodke, odloča o predlogih | Hitrejše planiranje, jasne posledice sprememb |
| Voznik/ekipa — sekundarni | Izvaja dodeljene naloge | Jasno zaporedje nalog in status |
| Vodstvo ustanove | Analizira učinkovitost | Merljive zamude, izraba vozil, čas odziva |
| Pacient — prejemnik koristi | Prevoz v ustreznem roku | Manj zamud; brez izpostavljanja osebnih podatkov v prototipu |

## 2. Uporabniške zgodbe

1. **Začetni plan:** Kot dispečer želim iz seznama vozil in nalog z enim klikom ustvariti izvedljiv razpored.
2. **Pregled stanja:** Želim videti, kje so vozila, v katerem stanju so, katere naloge so dodeljene in kdaj bodo opravljene.
3. **Okvara:** Če se vozilo pokvari, želim takoj vedeti, katere prihodnje naloge so ogrožene, in dobiti več alternativ.
4. **Nova prednostna naloga:** Če dispečer doda novo nalogo z določeno prioriteto, želim dobiti opozorilo, kaj je mogoče opraviti in kaj bo zamujalo.
5. **Odločanje:** Želim primerjati alternative po zamudah, številu sprememb urnika in rezervi, nato eksplicitno potrditi izbrani predlog.
6. **Neizvedljivost:** Če vozil, opreme ali časa ni dovolj, želim pojasnilo in seznam nerazporejenih nalog, ne lažno izvedljivega urnika.
7. **Sledljivost:** Želim videti staro in novo verzijo plana ter razlog odločitve.

## 3. Funkcionalnosti in prioritete

### Must-have (MVP)

1. **Dashboard:** kartice KPI; seznam vozil s statusi, opremo in naslednjo razpoložljivostjo; tabela nalog z nujnostjo, časovnimi okni in dodelitvami.
2. **Vizualizacija:** zemljevid lokacij vozil, prevzemov in ustanov ter **Gantt/časovnica** posameznih vozil. Če zemljevid nima internetne povezave, naj ostane uporabna tabela in časovnica.
3. **Generiranje plana:** izvedljivi začetni razpored ob trdih omejitvah.
4. **Motnje:** simulacija okvare vozila, prometnega zastoja/zapore in dodajanja nove naloge.
5. **Replan:** najmanj dva različna predloga (če dejansko obstajata), izpis metrik, sprememb in nerešenih nalog.
6. **Potrditev/odklonitev:** samo potrjeni predlog spremeni aktivni plan; stare verzije in odločitev ostanejo shranjene.
7. **Demo reset:** ponovljiv scenarij z enakimi podatki za predstavitev.

### Should-have (če ostane čas)

- Ročna sprememba dodelitve s preverjanjem omejitev.
- Napovedana zapora ali slabo vreme → daljši čas vožnje / dodatni buffer.
- Razpoložljivost bolnišnice ter simulirana omejitev sprejema.
- Enostavna statistika, primerjava pred/po, zgodovina dogodkov.

### Kasnejše nadgradnje

- Dejanski prometni viri: HERE, TomTom, promet.si, če so pogoji in API-ji ustrezni; **OSRM je routing storitev, ne vir realnočasovnih prometnih zastojev**.
- Vreme in zanesljivost napovedi, prediktivni čas prihoda, prilagoditev več bolnišnicam, ekipe in izmene, polnjenje/gorivo, komunikacija z ekipami, simulacijski analitični modul, integracije z obstoječimi informacijskimi sistemi.
- Timefold (Java) ali OR-Tools kot nadgradnja optimizacijskega jedra.

## 4. Podatkovni model

Poimenovanje je namenoma enotno: **naloga = task**, **motnja = incident**. Prometna nesreča, ki zahteva prevoz, lahko ustvari *novo nalogo*; prometna nesreča, ki zapre cesto, je *motnja*.

### `vehicles`

- `id`, `code`, `vehicle_type`
- `status`: `AVAILABLE`, `EN_ROUTE`, `TRANSPORTING`, `UNAVAILABLE`, `BROKEN`
- `current_lat`, `current_lon`, `location_updated_at`
- `base_location_id`, `current_task_id` (nullable), `target_lat`, `target_lon` (nullable)
- `capacity`, `equipment` (nabor oznak, npr. `STRETCHER`, `WHEELCHAIR`, `OXYGEN`)
- `available_at`

### `hospitals` / `facilities`

- `id`, `name`, `lat`, `lon`
- `specialties`  — **poenostavljene simulirane sposobnosti**
- `capacity_available` — **izključno sintetično**, ne realno stanje postelj
- `accepting` (bool), `updated_at`
- Pomembno: ciljna ustanova mora biti praviloma že klinično potrjena; optimizator jo lahko predlaga le kot informativno možnost s človeško potrditvijo.

### `tasks`

- `id`, `task_type`: `PLANNED_TRANSPORT`, `UNPLANNED_TRANSPORT`, `PRIORITY_TRANSPORT`, `EQUIPMENT_DELIVERY`
- `status`: `PENDING`, `ASSIGNED`, `EN_ROUTE_TO_PICKUP`, `PICKED_UP`, `COMPLETED`, `CANCELLED`, `FAILED`, `NEEDS_REASSIGNMENT` - **failed = neki narobe pr picakou,cancled = nesko scanslu**
- `priority`: `P1`, `P2`, `P3` — **vnesena, ne ocenjena z AI**
- `pickup_lat`, `pickup_lon`, `dropoff_lat`, `dropoff_lon`, `destination_facility_id` (nullable)
- `passenger_count`, `required_equipment`, `required_crew` (opcijsko)
- `earliest_pickup` (želeni prevzem), `latest_pickup` (najkasneje v vozilu; izpeljano iz prioritete: srednja +45 min, nizka +2 h, visoka brez roka – čim prej in absolutna prednost). Želenega in najkasnejšega prihoda v ustanovo ni.
- `pickup_service_minutes`, `dropoff_service_minutes`
- `created_at`, `planned_pickup`, `planned_arrival`, `actual_pickup`, `actual_arrival`
- `assigned_vehicle_id` (nullable; denormaliziran prikaz aktivne dodelitve, če ga potrebujemo)
- Brez imen pacientov in drugih osebnih zdravstvenih podatkov v demo bazi.

### `plans` in `assignments`

- `plans`: `id`, `version`, `status` (`DRAFT`, `ACTIVE`, `SUPERSEDED`), `created_at`, `trigger_incident_id`, `objective_name`, `metrics_json`
- `assignments`: `id`, `plan_id`, `task_id`, `vehicle_id`, `sequence_order`, `planned_departure`, `planned_pickup`, `planned_dropoff`, `planned_end`, `status` (`PLANNED`, `LOCKED`, `COMPLETED`, `SUPERSEDED`)
- En `task_id` ima največ eno aktivno dodelitev v okviru enega plana. Različne verzije planov hranimo ločeno.

### `incidents`

- `id`, `incident_type`: `VEHICLE_BREAKDOWN`, `TRAFFIC_DELAY`, `ROAD_CLOSURE`, `NEW_TASK`, `VEHICLE_UNAVAILABLE`, `HOSPITAL_CAPACITY_CHANGE`, `TASK_PRIORITY_UPDATED`, `WEATHER_DELAY`, `LOW_FUEL`
- `status`: `OPEN`, `RESOLVED`; `occurred_at`, `created_at`, `description`
- `affected_vehicle_id`, `affected_task_id`, `affected_facility_id` (nullable), `location`, `duration_minutes`, `delay_multiplier` (odvisno od vrste)
- `source`: `SIMULATED` za MVP; kasneje realen vir + `observed_at`
- Spremembo zdravstvene prioritete mora sprožiti pooblaščena oseba.

### `recommendations` in `decisions`

- `recommendations`: `id`, `incident_id`, `base_plan_id`, `proposed_plan_id`, `strategy` (`MIN_DELAY`, `MIN_CHANGES`, `MAX_BUFFER`), `status` (`PROPOSED`, `ACCEPTED`, `REJECTED`), `metrics_json`, `explanation`, `created_at`
- `decisions`: `id`, `recommendation_id`, `action`, `reason`, `decided_at`, `actor` (demo: `dispatcher`)

### Dodatno kasneje

- `crews`, `shifts`, `equipment`, `travel_time_cache`, `road_events` (geometrija, začetni/konec veljavnosti), `audit_log`.

## 5. Ključna poslovna pravila in omejitve

### Trde omejitve — nikoli jih ne kršimo

- Vozilo mora biti operativno in na voljo; ne more opravljati dveh prevozov, ki se prekrivata.
- Vrsta, oprema, razpoložljiva posadka (če modelirana) in kapaciteta morajo ustrezati nalogi.
- Vozilo mora najprej priti na prevzemno lokacijo, opraviti prevzem in šele nato predajo.
- Upoštevanje `earliest_pickup` in obveznih najpoznejših terminov; neizvedljive naloge ostanejo označene kot nerazporejene.
- Upoštevanje trajanja prevzema/predaje/čiščenja ter obdobij nedosegljivosti.
- Že opravljene, aktivno potekajoče in zaklenjene dodelitve so pri ponovnem planiranju nespremenljive.
- Če bolnišnica ne sprejema ali nima ustrezne simulirane kapacitete, ji ne dodelimo novega prihoda brez odločitve uporabnika.

### Mehki cilji — vrstni red po pomembnosti

1. Čim manj nerazporejenih nalog, s posebno težo za P1 (v mejah trdih omejitev).
2. Čim manj skupne zamude in čim manj zamud prednostnih nalog.
3. Čim manj sprememb že načrtovanih voženj.
4. Čim krajši skupni čas vožnje / prazni kilometri.
5. Več uporabne časovne rezerve za nepričakovane dogodke.

**Pomembno:** prednost ne dovoljuje kršenja varnostnih pravil. Če izvedljiv plan ne obstaja, sistem pokaže nerazporejene naloge, razloge in potrebo po dodatnih virih/eskalaciji.

## 6. Algoritem in način odločanja

**Pristop za MVP:** implementacija zanesljivega lastnega algoritma *greedy insertion + feasibility validation*, z jasno mejo (interface) `Planner`, da ga je kasneje možno nadomestiti z OR-Tools ali Timefold. Namen je **dejansko delujoč rezultat**, ne samo mock rezultat algoritma.

1. Zgradimo matriko časov med lokacijami. MVP: deterministični Haversine + faktor cestne razdalje / hitrost; po želji OSRM HTTP adapter. **Brez pretvarjanja, da statični OSRM prikazuje aktualen promet.**
2. Razvrstimo naloge po prioriteti, časovni zahtevnosti in najpoznejšem dovoljenem prihodu.
3. Za vsako nalogo preverimo vse izvedljive vrzeli med nalogami vseh vozil (vstavitev), ne samo najbližjega vozila.
4. Vsako kandidatno dodelitev ocenimo po izbrani uteženi strategiji; preverimo omejitve pred sprejemom.
5. Shranimo plan, metrike in seznam nerazporejenih nalog.
6. Ob motnji ohranimo potrjene/začete naloge, posodobimo stanje in ponovno optimiziramo preostali del.
7. Izvedemo več optimizacij z različnimi utežmi: `MIN_DELAY`, `MIN_CHANGES`, `MAX_BUFFER`. Prikažemo **samo dejansko različne in izvedljive** rezultate; če je samo eden, to jasno povemo.
8. Predlog **ni avtomatsko aktiviran**. Potrdi ga dispečer; ob potrditvi atomarno aktiviramo novo verzijo in ohranimo zgodovino.

### Alternativne strategije

| Strategija | Kaj poudari | Kaj pokažemo uporabniku |
|---|---|---|
| `MIN_DELAY` | Zamude in prednostne naloge | Predvidene zamude, naloge brez dodelitve |
| `MIN_CHANGES` | Stabilnost potrjenega plana | Število prerazporeditev |
| `MAX_BUFFER` | Rezerve za prihodnje dogodke | Najnižji/mediani razpoložljivi buffer |

## 7. Scenariji motenj

**MVP:**
- Okvara vozila; če je pacient že v vozilu, **ne avtomatiziramo fizične predaje**: ustvarimo opozorilo in nalogo za koordinirano posredovanje pristojne ekipe.
- Prometna zapora / zastoj; višji čas vožnje na prizadetih relacijah v simulaciji.
- Nova naloga s strani dispečerja, vključno z že določeno višjo prioriteto.

**Razširitev:** vremenska motnja, zmanjšana simulirana kapaciteta ustanove, sprememba klinične prioritete na podlagi odločitve strokovnjaka, odmori, čiščenje, nizko gorivo, preklic naloge.

## 8. UI / UX

**Glavni zaslon (slovenščina):**

- Zgornje kartice: aktivna vozila, naloge, zamujajoče/ogrožene naloge, nerazporejene naloge.
- Levo: vozila s statusom, opremo, trenutno/dokončno lokacijo in `available_at`.
- Sredina: zemljevid območja in markerji vozil, nalog in ustanov; ob izpadu zemljevida ostanejo drugi deli delujoči.
- Spodaj: Gantt/časovnica dodelitev po vozilih.
- Desno: **Incident center** z gumbi »Okvara V3«, »Zastoj«, »Nova naloga«, »Ponastavi demo«.
- **Recommendations modal/panel:** primerjava alternativ (zamude, spremembe, nerazporejene naloge, pojasnilo), gumbi »Potrdi« in »Zavrni«.
- Jasno označevanje **SIMULIRANI PODATKI** in stanja, ki čaka na potrditev.

## 9. API pogodba (predlog)

- `GET /api/state` — vozila, ustanove, naloge, aktivni plan, trenutni simulirani čas.
- `POST /api/plans/generate` — priprava začetnega plana (in nastavitev aktivnega plana, če še ni obstoječega).
- `POST /api/incidents` — vnese simulirano motnjo; ne potrdi novega plana.
- `POST /api/recommendations/generate` — izračuna alternative iz trenutnega aktivnega plana in motnje.
- `GET /api/recommendations` — vrne alternative za prikaz.
- `POST /api/recommendations/{id}/accept` — atomarna aktivacija predlagane verzije.
- `POST /api/recommendations/{id}/reject` — zavrnitev, aktivni plan ostane isti.
- `GET /api/metrics` — KPI in primerjava stanj.
- `POST /api/demo/reset` — determinističen reset seed podatkov.
- `POST /api/demo/advance-time` — simulacija poteka časa (opcijsko, priporočeno).

## 10. Predlagani tehnološki sklad

**Priporočilo za hiter hackathon prototip:**

- Frontend: React + TypeScript + Vite + Tailwind CSS; Leaflet/OpenStreetMap za zemljevid, če je omrežje dosegljivo.
- Backend: Python + FastAPI + Pydantic + SQLAlchemy.
- Baza: SQLite.
- Algoritem: lastni deterministic greedy insertion + hard-constraint validator; `Planner` interface za prihodnji OR-Tools/Timefold.
- Potovalni časi: lokalni deterministični adapter kot obvezni fallback; OSRM adapter kot izbirna možnost.
- Testiranje: pytest, vsaj osnovni API testi in testi načrtovalnika.

**Zakaj:** manj integracijskega tveganja za štiričlansko ekipo v 24 urah. Če imate že pripravljeno Java kodo, lahko backend nadomestite z Java/Timefold, vendar ne prepisujte delujočega dela po nepotrebnem.

## 11. Kriteriji uspeha in primerjalni baseline
ß
**Baseline:** prvi načrt brez replaniranja po motnji (ali preprosta najbližja-prosta-dodelitev) na istih simuliranih vhodih.

Merimo:
- število nerazporejenih nalog (posebej po prioritetah);
- število zamud in vsoto zamud v minutah;
- število spremenjenih dodelitev ob ponovnem planiranju;
- skupni načrtovani čas vožnje in prazne kilometre, če jih modeliramo;
- izračunani varnostni buffer;
- procesni čas izračuna (ne trdimo, da je enak dejanskemu dispečerskemu času odločanja).

Primerjave morajo biti reproducibilne; **nikoli ne prikazujemo vnaprej izmišljenih izboljšav kot izmerjenih rezultatov**.

## 12. Demo zgodba za žirijo

1. Klik »Ponastavi demo«: 5 vozil, 20 nalog, 3–4 sintetične ustanove, čas 08:00.
2. Klik »Generiraj plan«: sistem dodeli izvedljive naloge in pokaže urnik, zemljevid, KPI.
3. Premik simulirane ure na 11:20 (ali demo scenarij, pripravljen za to uro).
4. Klik »Pokvari V3«: vidno opozorilo, prizadete prihodnje naloge.
5. Klik »Predlagaj rešitve«: vsaj dve različni alternativi **če jih podatki dopuščajo**, skupaj z merljivimi posledicami.
6. Dispečer izbere predlog, klikne »Potrdi« in vidi posodobljen aktivni plan ter zgodovino verzij.
7. Dodajte novo prednostno nalogo ali zastoj in pokažite ponovno prilagoditev.
8. Kratek prikaz »ni izvedljive rešitve« in razlage, kaj manjka.

**30-sekundni pitch:** »Dispečer skrbno načrtuje dan, nato se vozilo pokvari. Kateri pacienti bodo zamujali? Katero vozilo je primerna alternativa? Naš sistem ne optimizira le poti, ampak pomaga hitro, pregledno in varno prilagoditi celoten razpored. Izračuna več izvedljivih možnosti, pojasni njihove posledice, končno odločitev pa prepusti dispečerju.«

## 13. Časovni načrt za 4 osebe / 24 ur

| Del ekipe | Glavna odgovornost | Izdelek |
|---|---|---|
| 1 — Backend/DB | Entitete, seed, REST API, verzije planov | Zanesljiv backend |
| 2 — Algoritem | Matrika časov, validator, začetni plan, replan, KPI | Dejanska optimizacija |
| 3 — Frontend | Dashboard, časovnica, incident panel, zemljevid | Uporaben demo UI |
| 4 — Integracija/pitch | UX, testni primeri, demo scenarij, metrike, prezentacija | Delujoča zgodba in dokaz vrednosti |

**Vrstni red:** najprej model + determinističen seed → delujoči plan → okvara + replan → primerjava alternativ → potrditev → poliranje UX/zemljevida → teste in demo. Ne začnite s prometnimi API-ji ali LLM-integracijo.

## 14. Odprta vprašanja za Epilog

1. Katere vrste prevozov so v resničnem obsegu: nenujni, sanitetni, nujni, medbolnišnični?
2. Kaj je danes najzahtevnejše: začetni urnik ali odziv na spremembe?
3. Katere trde omejitve so obvezne (posadke, vrste vozil, oprema, prevzem/predaja, roki)?
4. Kakšni so tipični prevozi in trajanja opravil?
5. Kateri viri položajev, prometa in sprejemnih kapacitet so dejansko na voljo?
6. Ali se že začete dodelitve lahko prestavljajo? Kdo potrdi spremembe?
7. Kaj je pravilen postopek, ko ni dovolj ustreznih vozil?
8. Po katerem KPI bi presodili uporabnost rešitve?

## 15. Ne trdimo, da prototip zmore več, kot dejansko zmore

- Ni klinični odločevalec in ni operativni sistem 112.
- Vsi podatki o pacientih in kapacitetah so sintetični.
- OSRM sam ne daje realnega prometa; sintetične zapore morajo biti označene.
- Medicinske prioritete in izbira ciljne ustanove zahtevajo človeško presojo.
- Če omejitev ni mogoče zadovoljiti, sistem mora izpisati nerešeno stanje.
- »AI priporočilo« v MVP-ju pomeni transparentni optimizacijski algoritem, ne nujno jezikovni model.
