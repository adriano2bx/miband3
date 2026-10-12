"""Reject truncated or corrupt PNG resources before packaging the Android app."""
from pathlib import Path
import struct
import zlib


def validate_png(path: Path) -> None:
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path}: invalid PNG signature")
    offset = 8
    image_data = bytearray()
    seen_header = False
    while offset < len(data):
        if offset + 12 > len(data):
            raise ValueError(f"{path}: truncated chunk header")
        length = struct.unpack_from(">I", data, offset)[0]
        end = offset + 12 + length
        if end > len(data):
            raise ValueError(f"{path}: truncated PNG chunk")
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:end - 4]
        crc = struct.unpack_from(">I", data, end - 4)[0]
        if zlib.crc32(kind + payload) != crc:
            raise ValueError(f"{path}: invalid {kind!r} checksum")
        if not seen_header:
            if kind != b"IHDR" or length != 13:
                raise ValueError(f"{path}: missing image header")
            seen_header = True
        if kind == b"IDAT":
            image_data.extend(payload)
        if kind == b"IEND":
            if length != 0 or end != len(data) or not image_data:
                raise ValueError(f"{path}: invalid PNG ending")
            decoder = zlib.decompressobj()
            decoder.decompress(image_data)
            if not decoder.eof or decoder.unused_data:
                raise ValueError(f"{path}: incomplete image data")
            return
        offset = end
    raise ValueError(f"{path}: missing IEND chunk")


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    resources = sorted((root / "app/src/main/res").rglob("*.png"))
    for resource in resources:
        validate_png(resource)
    print(f"Validated {len(resources)} Android PNG resources")
