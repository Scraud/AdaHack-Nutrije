# Lokalno cestno omrežje

## Cestni izsek za demo

Datoteka `backend/app/providers/data/ljubljana.json.gz` vsebuje omejen izsek OpenStreetMap za Ljubljano. Cestna geometrija in podatki so na voljo pod licenco ODbL 1.0. Izsek uporablja enosmerne ceste ter grobe hitrosti po kategorijah. Omejitve zavijanja in trenutni promet zunaj dogodkov v demu niso modelirani. [© avtorji OpenStreetMap](https://www.openstreetmap.org/copyright)

Izvor je Geofabrikov slovenski izsek s časom replikacije `2026-11-20T21:21:21Z`. Za obnovitev prenesite izsek v `routing/data/slovenia.osm.pbf` ter zaženite:

```sh
python -m pip install osmium
python routing/build_ljubljana.py routing/data/slovenia.osm.pbf backend/app/providers/data/ljubljana.json.gz
```

[Slovenski izsek na Geofabriku](https://download.geofabrik.de/europe/slovenia.html)

## Izbirni OSRM

Iz korena projekta pripravite cestni graf in zaženite Compose s profilom `routing`.

```sh
sh routing/prepare.sh
RESCUEFLOW_OSRM_URL=http://osrm:5000 docker compose --profile routing up --build
```

Skripta prenese izvleček Slovenije in ga pripravi s profilom `car.lua` in postopkom CH. Če imate svoj izvleček, ga shranite kot `routing/data/slovenia.osm.pbf` pred zagonom skripte. Pred ponovno pripravo grafa ustavite OSRM. Po zamenjavi grafa ponovno zaženite tudi backend, da osveži predpomnilnik matrik. Za primerjavo izračunov z drugim grafom začnite nov demo scenarij. [Izvleček OpenStreetMap za Slovenijo](https://download.geofabrik.de/europe/slovenia.html) · [Dokumentacija OSRM](https://github.com/Project-OSRM/osrm-backend/blob/v5.27.1/docs/http.md#table-service)

Plan vsebuje `distance_meters` za posamezno dodelitev in skupno razdaljo, ki vključuje vožnjo do prevzema in vožnjo s pacientom. `/api/state` v polju `travel_source` navede vir izračuna, `OSM_LJUBLJANA` ali `OSRM`. Sledenje za aktivni plan uporabi poti iz vira, s katerim je bil plan izračunan.

Za aktivne simulirane zastoje in zapore izbranih cestnih odsekov planer uporabi priloženo cestno omrežje Ljubljane, kjer se vpliv upošteva na posameznih odsekih.

Če je za izračun izbran OSRM in potrebne matrike ni mogoče pridobiti, API vrne `503 ROAD_ROUTING_UNAVAILABLE`.
