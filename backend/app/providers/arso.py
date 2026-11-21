from dataclasses import dataclass
from datetime import datetime
from email.utils import parsedate_to_datetime

from app.providers.http import read_xml

OBSERVATION_URL = (
    "https://meteo.arso.gov.si/uploads/probase/www/observ/surface/text/sl/"
    "observationAms_LJUBL-ANA_BEZIGRAD_latest.xml"
)


@dataclass(frozen=True)
class Observation:
    time: datetime
    description: str


def latest_observation(content: bytes) -> Observation:
    root = read_xml(content)
    observations = []
    for event in root.findall("metData"):
        stamp = event.findtext("tsValid_issued_RFC822") or event.findtext("tsUpdated_RFC822")
        if not stamp:
            continue
        time = parsedate_to_datetime(stamp)
        if time.tzinfo is None:
            continue
        temperature = event.findtext("t")
        pieces = [f"{float(temperature):g} °C"] if temperature else []
        weather = event.findtext("wwsyn_shortText") or event.findtext("nn_shortText")
        if weather:
            pieces.append(weather)
        observations.append(Observation(time, " · ".join(pieces) or "Meritev samodejne postaje"))
    if not observations:
        raise ValueError("Missing ARSO observation")
    return max(observations, key=lambda item: item.time)
