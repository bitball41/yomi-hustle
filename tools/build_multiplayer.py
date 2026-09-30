#!/usr/bin/env python3
"""Rebuild only the multiplayer scripts in the Godot 3.5.1 export.

Requires GDRE Tools 2.6.4 (https://github.com/GDRETools/gdsdecomp).
All other pack entries are preserved byte-for-byte, with fresh offsets/checksums.
"""
import argparse
import hashlib
import re
import struct
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = {
    "WebsocketClient": "res://networking/WebsocketClient.gdc",
    "Network": "res://Network.gdc",
    "Lobby": "res://ui/Lobby.gdc",
}


def read_pack(data):
    assert data[:4] == b"GDPC" and struct.unpack_from("<I", data, 4)[0] == 1
    count = struct.unpack_from("<I", data, 84)[0]
    entries, pos = [], 88
    for _ in range(count):
        length = struct.unpack_from("<I", data, pos)[0]
        pos += 4
        name = data[pos:pos + length].rstrip(b"\0").decode("utf-8")
        pos += length
        offset, size = struct.unpack_from("<QQ", data, pos)
        pos += 16
        checksum = data[pos:pos + 16]
        pos += 16
        contents = data[offset:offset + size]
        assert len(contents) == size and hashlib.md5(contents).digest() == checksum, name
        entries.append((name, contents))
    return entries


def write_pack(header, entries):
    directory_size = 88 + sum(4 + ((len(n.encode()) + 3) // 4) * 4 + 32 for n, _ in entries)
    offset = (directory_size + 15) // 16 * 16
    directory, body = bytearray(), bytearray()
    for name, contents in entries:
        encoded = name.encode()
        encoded += b"\0" * (-len(encoded) % 4)
        directory += struct.pack("<I", len(encoded)) + encoded
        directory += struct.pack("<QQ", offset, len(contents)) + hashlib.md5(contents).digest()
        body += contents
        padding = -len(contents) % 16
        body += b"\0" * padding
        offset += len(contents) + padding
    result = header[:84] + struct.pack("<I", len(entries)) + directory
    result += b"\0" * (-len(result) % 16)
    return result + body


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gdre", required=True, type=Path, help="Path to gdre_tools executable")
    args = parser.parse_args()
    original = (ROOT / "index.pck").read_bytes()
    entries = read_pack(original)
    replacements = {}
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        for name, resource in SCRIPTS.items():
            source = (ROOT / "multiplayer" / (name + ".gd")).read_text()
            if name == "WebsocketClient":
                js = (ROOT / "multiplayer" / "photon-bridge.js").read_text()
                embedded = js.replace("\\", "\\\\").replace('"', '\\"')
                source = source.replace('const PHOTON_BRIDGE_SOURCE = ""', 'const PHOTON_BRIDGE_SOURCE = """' + embedded + '"""')
            path = tmp / (name + ".gd")
            path.write_text(source)
            subprocess.run([str(args.gdre.resolve()), "--headless", "--bytecode=3.5.1", "--output=" + str(tmp), "--compile=" + str(path)], check=True)
            replacements[resource] = path.with_suffix(".gdc").read_bytes()
    assert replacements.keys() <= {name for name, _ in entries}
    patched = write_pack(original, list(replacements.items()))
    assert dict(read_pack(patched)) == replacements
    (ROOT / "multiplayer" / "patch.pck").write_bytes(patched)
    html = ROOT / "index.html"
    source = re.sub(r'("index.pck":)\d+', lambda m: m[1] + str(len(original)), html.read_text())
    source = re.sub(r'("multiplayer/patch.pck":)\d+', lambda m: m[1] + str(len(patched)), source)
    html.write_text(source)
    print(f"Built {len(replacements)} script patches; verified {len(entries)} base pack checksums. Patch size: {len(patched)}.")


if __name__ == "__main__":
    main()
