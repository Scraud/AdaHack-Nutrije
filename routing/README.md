# Lokalni OSRM

## Cestni izsek za demo

Datoteka `backend/app/providers/data/ljubljana.json.gz` vsebuje omejen izsek OpenStreetMap za Ljubljano. Cestna geometrija in podatki so na voljo pod licenco ODbL 1.0. Izsek uporablja enosmerne ceste ter grobe hitrosti po kategorijah. Omejitve zavijanja in trenutni promet zunaj dogodkov v demu niso modelirani. [© avtorji OpenStreetMap](https://www.openstreetmap.org/copyright)

Izvor je Geofabrikov slovenski izsek s časom replikacije `2026-11-20T21:21:21Z`. Za obnovitev prenesite izsek v `routing/data/slovenia.osm.pbf` ter zaženite:

```sh
python -m pip install osmium
python routing/build_ljubljana.py routing/data/slovenia.osm.pbf backend/app/providers/data/ljubljana.json.gz
```

[Slovenski izsek na Geofabriku](https://download.geofabrik.de/europe/slovenia.html)

## Izbirni OSRM

Pripravite regionalni izvleček OpenStreetMap za Slovenijo s profilom `car.lua`. Uporabite isto različico OSRM za `osrm-extract`, `osrm-partition`, `osrm-customize` in `osrm-routed`. Vse datoteke `slovenia.osrm.*` shranite v `routing/data/`. V `.env` nastavite `RESCUEFLOW_OSRM_URL=http://osrm:5000` in zaženite `docker compose --profile routing up --build`.

Gumb »Osveži zunanje vire« preveri eno cestno relacijo v Ljubljani. Potrditev povezave z OSRM je neodvisna od demo matrike. [Dokumentacija OSRM](https://project-osrm.org/docs/v5.24.0/api/)
