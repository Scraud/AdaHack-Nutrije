# Lokalni OSRM

Pripravite regionalni izvleček OpenStreetMap za Slovenijo s profilom `car.lua`. Uporabite isto različico OSRM za `osrm-extract`, `osrm-partition`, `osrm-customize` in `osrm-routed`. Vse datoteke `slovenia.osrm.*` shranite v `routing/data/`. V `.env` nastavite `RESCUEFLOW_OSRM_URL=http://osrm:5000` in zaženite `docker compose --profile routing up --build`.

Gumb »Osveži zunanje vire« preveri eno cestno relacijo v Ljubljani. Potrditev povezave z OSRM je neodvisna od demo matrike. [Dokumentacija OSRM](https://project-osrm.org/docs/v5.24.0/api/)
