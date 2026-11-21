import xml.etree.ElementTree as ET

import httpx


def fetch(client: httpx.Client, url: str, *, headers: dict[str, str] | None = None,
          params: dict[str, str] | None = None) -> bytes:
    with client.stream("GET", url, headers=headers, params=params) as response:
        response.raise_for_status()
        chunks = bytearray()
        for chunk in response.iter_bytes():
            chunks.extend(chunk)
            if len(chunks) > 4_000_000:
                raise ValueError("Response exceeds the size limit")
    return bytes(chunks)


def read_xml(content: bytes) -> ET.Element:
    xml = content.decode("utf-8-sig")
    if "<!DOCTYPE" in xml or "<!ENTITY" in xml:
        raise ValueError("Unexpected XML document declaration")
    return ET.fromstring(xml)
