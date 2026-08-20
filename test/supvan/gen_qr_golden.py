#!/usr/bin/env python3
"""Generate QR golden vectors from `segno` (a conformant reference generator).

Run with a Python that has segno installed, e.g. a venv:

    python3 -m venv /tmp/qrref && /tmp/qrref/bin/pip install segno
    /tmp/qrref/bin/python test/supvan/gen_qr_golden.py > test/supvan/qr-golden.json

Each vector fixes mode='byte' and boost_error=False so segno's version/ECC match
our byte-only encoder. We emit two record kinds:
  * kind "auto": mask omitted -> tests OUR penalty-based mask selection.
  * kind "fixed": mask pinned -> tests placement/ECC independent of masking.

The matrix is serialised as one string per row of '0'/'1' (dark = '1').
"""
import json
import sys

import segno

# Inputs chosen to span several byte-mode versions and content shapes.
TEXTS = [
    "",  # empty
    "A",
    "12345",
    "HELLO WORLD",
    "https://ezoffice.example.com/assets/1234",
    "PT-LPT-TI-0007 / Dell Latitude 7440 / SN: ABCD1234",
    "https://ezoffice.example.com/asset?id=98765&name=Impressora%20Sala%203",
    "x" * 120,
    "y" * 300,
    "z" * 700,
    # A few non-ASCII (UTF-8 byte mode) with Portuguese characters.
    "Ativo: Impressão São João — Departamento Comunicação",
    "çãõáéíóúÀÂ",
]

LEVELS = ["l", "m", "q", "h"]


def matrix_rows(qr):
    rows = []
    for row in qr.matrix:
        rows.append("".join("1" if v else "0" for v in row))
    return rows


def make_record(text, level, mask):
    try:
        # make_qr (NOT make) forces a standard QR symbol; make() would emit a
        # Micro QR (M1-M4) for short content, which we do not implement.
        qr = segno.make_qr(
            text if text != "" else " ",  # segno rejects empty; use single space sentinel
            error=level,
            mode="byte",
            mask=mask,
            # Force UTF-8 (no ECI header, since eci defaults to False) so segno's
            # byte segment matches our encoder, which always encodes UTF-8 bytes.
            # segno's default byte encoding is ISO-8859-1, which would use fewer
            # bytes for Latin-1 content and diverge on version selection.
            encoding="utf-8",
            boost_error=False,
        )
    except Exception:  # noqa: BLE001
        return None
    return {
        "text": text if text != "" else " ",
        "ecc": level.upper(),
        "version": qr.version,
        "mask": qr.mask,
        "kind": "fixed" if mask is not None else "auto",
        "size": len(qr.matrix),
        "rows": matrix_rows(qr),
    }


def main():
    vectors = []
    for text in TEXTS:
        for level in LEVELS:
            # auto-mask record
            rec = make_record(text, level, None)
            if rec:
                vectors.append(rec)
            # fixed-mask records (a couple of masks to exercise placement)
            for mask in (0, 5):
                rec = make_record(text, level, mask)
                if rec:
                    vectors.append(rec)
    json.dump({"segno": segno.__version__, "vectors": vectors}, sys.stdout)


if __name__ == "__main__":
    main()
