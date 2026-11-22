# Gladko premikanje vozil in brisanje prevožene poti

Ta dokument opisuje gladko premikanje vozil na zemljevidu in samodejno prilagajanje poti ob cestnih motnjah. Animacija je v paketu `frontend/packages/react-views`; interval osveževanja sledenja ostaja nespremenjen.

## Kaj se je spremenilo

- Vozilo se med dvema prejetima okvirjema sledenja (vsako sekundo) gladko premika po narisani poti. Prej je oznaka ob vsakem okvirju skočila na novo lokacijo.
- Premik sledi geometriji ceste, zato oznaka v ovinkih ne seka vogalov.
- Že prevoženi del poti se sproti briše. Na zemljevidu ostane samo pot od trenutnega položaja vozila naprej.
- Ko vozilo prevzame pacienta, polna črta do pacienta izgine, pikčasta črta do ustanove pa se začne krajšati. Ob prihodu v ustanovo izgine tudi ta.
- Slog, barve in razredi črt (`route-to-pickup`, `route-to-hospital`, `stroke-dasharray: 2 8`) so enaki kot prej, zato obstoječi E2E test ostaja veljaven.

## Spremenjene datoteke

### `frontend/packages/react-views/src/route-motion.ts` (nova)

Čisti geometrijski pomočniki brez odvisnosti od Leafleta:

| Funkcija | Namen |
| --- | --- |
| `measure(path)` | Izračuna kumulativne razdalje točk poti v metrih (ekvirektangularni približek) in skupno dolžino. Vrne `Leg`. |
| `pointAt(leg, d)` | Vrne koordinato na razdalji `d` vzdolž poti z linearno interpolacijo znotraj odseka. |
| `remaining(leg, d)` | Vrne preostanek poti od razdalje `d` do konca. Prva točka je točen položaj vozila. Na koncu poti vrne prazen seznam. |
| `project(leg, point)` | Projicira lokacijo na najbližji odsek poti in vrne razdaljo vzdolž poti. |
| `progress(vehicle, approach, delivery)` | Iz statusa in lokacije vozila izračuna skupni napredek po obeh delih poti. |

Napredek glede na status vozila:

| Status | Napredek |
| --- | --- |
| `WAITING` | `0` |
| `TO_PICKUP` | projekcija lokacije na pot do pacienta |
| `AT_PICKUP` | dolžina poti do pacienta |
| `TO_HOSPITAL` | dolžina poti do pacienta + projekcija na pot do ustanove |
| `AT_HOSPITAL` | skupna dolžina obeh poti |
| `STOPPED`, `GPS` | projekcija na tisti del poti, ki je lokaciji najbližji |

### `frontend/packages/react-views/src/dispatch-map.tsx`

- Ob ponovnem izrisu poti komponenta hrani reference na črte posameznega vozila (bela obroba in barvna črta za pot do pacienta in do ustanove).
- Za vsako vozilo hrani stanje animacije: ključ poti, izmerjena dela poti, začetni in ciljni napredek, trenutno prikazan napredek, čas začetka in trajanje.
- Ob novem okvirju sledenja izračuna ciljni napredek in animira od trenutno prikazanega položaja do cilja. Trajanje je enako izmerjenemu razmiku med okvirjema, omejeno na 250–1600 ms. Animacija je linearna, zato je hitrost enakomerna.
- Zanka `requestAnimationFrame` v vsakem koraku premakne oznako (`setLatLng`) in skrajša črte na preostanek poti (`setLatLngs`). Zanka se ustavi, ko vsa vozila dosežejo cilj, in se prekliče ob odstranitvi zemljevida.
- Takoj po ponovnem izrisu poti se črte narišejo že skrajšane, zato polna pot ne utripne.
- Oznaka vozila je shranjena skupaj s prikazom predvidenega časa prihoda (`{ marker, eta }`). Ob novem okvirju se posodobijo ETA, opis in prosojnost, položaj oznake pa nastavlja samo animacija, zato oznaka ne skoči na surovo lokacijo.

## Samodejni obvozi

- Ko dispečer doda ali odstrani zastoj oziroma zaporo, backend za simulirana vozila izračuna novo pot po lokalnem cestnem omrežju; zaprte povezave so izločene, zastoji pa upoštevani kot dodatni čas.
- Aktivni del poti se začne pri trenutni lokaciji vozila. Backend posodobi predvidene čase prevzema in prihoda, za naslednje načrtovane naloge pa ponovno izračuna čase vožnje in razpoložljivost vozila.
- Preusmeritev ne menja izbranega vozila ali vrstnega reda nalog, zato sprejeti dispečerjev plan ostane merodajen. Če obvoza ni, naloga ostane blokirana za ročno koordinacijo.
- Sledenje uporablja isti preusmerjeni odsek za položaj vozila in izris poti. To vpliva na simulirani način; v načinu GPS lokacijo še naprej določa prejeti GPS.
- Implementacija je v `backend/app/providers/roads.py` (`RoadNetwork.route`), `backend/app/services/simulation.py` (preračun ob dodajanju/odstranitvi motnje), `backend/app/services/tracking.py` (izris preusmerjene etape) in `backend/app/planning/contracts.py` (`Assignment.reroute`).

## Robni primeri

- **Nova ali spremenjena pot** (nova naloga, nov plan, zaobid zapore): vozilo brez animacije skoči na nov položaj, pot se nariše od tam naprej.
- **Vozilo brez poti** (način GPS): oznaka se linearno premakne med prejšnjo in novo lokacijo.
- **Napredek nazaj** (ponovni izračun, ustavitev): animacija se izvede do nove vrednosti, črta se ustrezno podaljša.
- **Konec poti**: `remaining` vrne prazen seznam, zato se črta skrije.
- **Odstranjeno vozilo**: odstranijo se oznaka, reference na črte in stanje animacije.

## Preverjanje

- `npm run build` v mapi `frontend` uspe.
- Geometrija je bila preverjena z Node.js na preprosti poti: dolžina, interpolacija točke, preostanek poti, projekcija in napredek za `TO_HOSPITAL` ter `AT_HOSPITAL`.
- Playwright E2E (`npm run test:e2e`) potrebuje backend v `.venv`. Glejte [README](../README.md#demo-in-preverjanje).
