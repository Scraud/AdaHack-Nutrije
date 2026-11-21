#!/bin/sh
set -eu

routing_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
data_dir="$routing_dir/data"
image=ghcr.io/project-osrm/osrm-backend:v5.27.1
mkdir -p "$data_dir"

if [ ! -s "$data_dir/slovenia.osm.pbf" ]; then
    download=$(mktemp "$data_dir/slovenia.osm.pbf.XXXXXX")
    trap 'rm -f "$download"' EXIT
    curl --fail --silent --show-error --location --retry 2 --output "$download" \
        https://download.geofabrik.de/europe/slovenia-latest.osm.pbf
    mv "$download" "$data_dir/slovenia.osm.pbf"
fi

docker run --rm -v "$data_dir:/data" "$image" \
    osrm-extract -p /opt/car.lua /data/slovenia.osm.pbf
docker run --rm -v "$data_dir:/data" "$image" osrm-contract /data/slovenia.osrm
