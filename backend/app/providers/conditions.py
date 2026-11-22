import os
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Lock
from xml.etree.ElementTree import ParseError

import httpx

from app.api.schemas import SourceStatus
from app.planning.contracts import Node, Point
from app.providers.arso import OBSERVATION_URL, latest_observation
from app.providers.http import fetch
from app.providers.nap import traffic_publication
from app.providers.osrm import road_snapshot

OWN_SOURCE = SourceStatus(
    id="local", name="Cestno omrežje Ljubljane", status="SIMULATED",
    message="OpenStreetMap · potovalni časi so ocene po vrsti ceste.",
)


class Conditions:
    def __init__(self):
        self.nap_url = os.getenv("RESCUEFLOW_NAP_URL")
        self.nap_token = os.getenv("RESCUEFLOW_NAP_TOKEN")
        self.osrm_url = os.getenv("RESCUEFLOW_OSRM_URL")
        self.checks = (("arso", "Vir: ARSO · Ljubljana Bežigrad", self._weather, True),
                       ("nap", "Promet.si / NAP", self._traffic, bool(self.nap_url)),
                       ("osrm", "OSRM · cestne poti", self._roads, bool(self.osrm_url)))
        self.lock = Lock()
        self.updated: datetime | None = None
        self.values = [SourceStatus(id=key, name=name, status="UNAVAILABLE",
                                    message="Čaka na osvežitev." if enabled else "Vir ni nastavljen.")
                       for key, name, _, enabled in self.checks]

    def get(self) -> list[SourceStatus]:
        now = datetime.now(UTC)
        return [OWN_SOURCE, *(self._freshness(source, now) for source in self.values)]

    @staticmethod
    def _freshness(source: SourceStatus, now: datetime) -> SourceStatus:
        maximum_age = timedelta(minutes=45 if source.id == "arso" else 15)
        if source.status == "LIVE" and source.observed_at and now - source.observed_at > maximum_age:
            return source.model_copy(update={"status": "STALE"})
        return source

    def refresh(self) -> list[SourceStatus]:
        if not self.lock.acquire(blocking=False):
            return self.get()
        try:
            now = datetime.now(UTC)
            if self.updated is not None and now - self.updated < timedelta(seconds=60):
                return self.get()
            with ThreadPoolExecutor(max_workers=3) as pool:
                jobs = [pool.submit(self._refresh_one, check, previous, now)
                        for check, previous in zip(self.checks, self.values, strict=True)]
                self.values = [job.result() for job in jobs]
            self.updated = now
            return self.get()
        finally:
            self.lock.release()

    def _refresh_one(self, check, previous: SourceStatus, now: datetime) -> SourceStatus:
        key, name, read, enabled = check
        if not enabled:
            return previous
        try:
            with httpx.Client(timeout=3.0, follow_redirects=False) as client:
                stamp, message = read(client, now)
            if stamp > now + timedelta(minutes=5):
                raise ValueError("Source timestamp is ahead of local time")
            return SourceStatus(id=key, name=name, status="LIVE", observed_at=stamp, message=message)
        except (httpx.HTTPError, httpx.InvalidURL, ValueError, ParseError, OverflowError):
            if previous.observed_at:
                return previous.model_copy(update={"status": "STALE",
                                                   "message": "Osvežitev ni uspela. " + previous.message.removeprefix("Osvežitev ni uspela. ")})
            return previous.model_copy(update={"message": "Vira ni bilo mogoče pridobiti ali preveriti."})

    def _weather(self, client: httpx.Client, now: datetime):
        observation = latest_observation(fetch(client, OBSERVATION_URL))
        return observation.time, observation.description + " · opazovanje zunaj demo scenarija."

    def _traffic(self, client: httpx.Client, now: datetime):
        headers = {"Authorization": f"Bearer {self.nap_token}"} if self.nap_token else None
        published, events = traffic_publication(fetch(client, self.nap_url, headers=headers), now)
        return published, f"{len(events)} veljavnih zapisov v viru · zunaj demo scenarija."

    def _roads(self, client: httpx.Client, now: datetime):
        nodes = (Node("a", "PICKUP", Point(lat=46.050, lon=14.505)),
                 Node("b", "DELIVERY", Point(lat=46.066, lon=14.480)))
        snapshot = road_snapshot(client, self.osrm_url, nodes)
        if snapshot.seconds("a", "b") is None:
            raise ValueError("Configured OSRM does not cover Ljubljana")
        return now, "Preverjena cestna matrika v Ljubljani. OSRM je nastavljen za izračun po cestah."
