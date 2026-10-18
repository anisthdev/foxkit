#!/usr/bin/python3
"""Native messaging host for foxkit: things an extension cannot do itself.

Messages are JSON, each framed by a 4-byte native-endian length, on
stdin/stdout. Every request carries an "id" that its reply echoes.

  {"id", "type": "supported", "url"}  ->  {"id", "supported": bool}
  {"id", "type": "play", "url"}       ->  {"id", "ok": true}
"""

import json
import os
import struct
import subprocess
import sys
from fnmatch import fnmatchcase
from pathlib import Path
from urllib.parse import urlsplit

from yt_dlp.extractor import gen_extractor_classes

# The generic extractor claims every URL; only site-specific ones count.
EXTRACTORS = [e for e in gen_extractor_classes() if e.IE_NAME != "generic"]

# Extra sites the generic extractor handles; see the file for its format.
SITES_FILE = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "foxkit" / "mpv-sites"

_sites = {"mtime": None, "entries": []}


def extra_sites():
    """[(host, path_glob)] from SITES_FILE, reread whenever it changes."""
    try:
        mtime = SITES_FILE.stat().st_mtime
    except FileNotFoundError:
        return []
    if mtime != _sites["mtime"]:
        entries = []
        for line in SITES_FILE.read_text().splitlines():
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            line = line.split("://", 1)[-1].removeprefix("*.")
            host, slash, path = line.partition("/")
            entries.append((host.lower(), slash + path if slash else "*"))
        _sites.update(mtime=mtime, entries=entries)
    return _sites["entries"]


def listed(url):
    parts = urlsplit(url)
    host = parts.hostname or ""
    target = parts.path + (f"?{parts.query}" if parts.query else "")
    return any(
        (host == site or host.endswith("." + site)) and fnmatchcase(target, path)
        for site, path in extra_sites()
    )


def supported(url):
    return listed(url) or any(e.suitable(url) for e in EXTRACTORS)


def play(url):
    subprocess.Popen(
        ["mpv", "--force-window=immediate", "--", url],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        # Outlive this host, which Firefox kills when the extension disconnects.
        start_new_session=True,
    )


def handle(message):
    kind = message.get("type")
    if kind == "supported":
        return {"supported": supported(message["url"])}
    if kind == "play":
        play(message["url"])
        return {"ok": True}
    return {"error": f"unknown message type: {kind}"}


def read():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("=I", header)
    return json.loads(sys.stdin.buffer.read(length))


def write(message):
    data = json.dumps(message).encode()
    sys.stdout.buffer.write(struct.pack("=I", len(data)) + data)
    sys.stdout.buffer.flush()


def main():
    while (message := read()) is not None:
        try:
            reply = handle(message)
        except Exception as error:
            reply = {"error": str(error)}
        write({"id": message.get("id"), **reply})


if __name__ == "__main__":
    main()
