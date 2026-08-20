#!/usr/bin/env python3
"""Generate byte-exact golden vectors for the SUPVAN core from the reference
Python client (heeen/supvan-cups, test_print.py) — the runnable ground truth.

Usage:
    SUPVAN_REF=/tmp/supvan-cups python3 test/supvan/gen_golden.py > test/supvan/golden-vectors.json

The reference path defaults to /tmp/supvan-cups. Importing test_print.py is
side-effect free (bluetooth/serial imports are guarded; main() is under a
__name__ guard). create_test_pattern prints diagnostics, so we mute stdout while
calling it.
"""
import contextlib
import io
import json
import os
import struct
import sys

REF = os.environ.get("SUPVAN_REF", "/tmp/supvan-cups")
sys.path.insert(0, REF)

import test_print as tp  # noqa: E402
import lzma as lzma_mod  # noqa: E402


def h(b) -> str:
    return bytes(b).hex()


@contextlib.contextmanager
def muted():
    saved = sys.stdout
    sys.stdout = io.StringIO()
    try:
        yield
    finally:
        sys.stdout = saved


LZMA_FILTERS = [{
    "id": lzma_mod.FILTER_LZMA1,
    "dict_size": 8192,
    "lc": 3, "lp": 0, "pb": 2,
    "mode": lzma_mod.MODE_NORMAL,
    "nice_len": 128,
    "mf": lzma_mod.MF_BT4,
}]


def lzma_alone(data: bytes):
    raw = lzma_mod.compress(data, format=lzma_mod.FORMAT_ALONE, filters=LZMA_FILTERS)
    patched = bytearray(raw)
    struct.pack_into("<Q", patched, 5, len(data))
    return raw, bytes(patched)


def status_frame(b14, b15, b16, b17, count):
    r = bytearray(20)
    r[0] = tp.MAGIC1
    r[1] = tp.MAGIC2
    r[7] = tp.CMD_INQUIRY_STA
    r[14], r[15], r[16], r[17] = b14, b15, b16, b17
    r[18] = count & 0xFF
    r[19] = (count >> 8) & 0xFF
    return bytes(r)


def material_frame(width, height, gap, label_type=7, sn=0x1234, remind=None,
                   uuid=b"\x01\x02\x03\x04\x05\x06\x07",
                   code=b"\x10\x11\x12\x13\x14\x15\x16\x17"):
    # BT framing: 22-byte header, payload begins at 22.
    n = 47 if remind is not None else 43
    r = bytearray(n)
    r[0] = tp.MAGIC1
    r[1] = tp.MAGIC2
    r[7] = tp.CMD_RETURN_MAT
    r[22:29] = uuid
    r[29:37] = code
    r[37] = sn & 0xFF
    r[38] = (sn >> 8) & 0xFF
    r[39] = label_type
    r[40] = width
    r[41] = height
    r[42] = gap
    if remind is not None:
        struct.pack_into("<I", r, 43, remind)
    return bytes(r)


def gen():
    out = {}

    # --- 16-byte command frames ---
    out["cmds"] = [
        {"name": name, "cmd": cmd, "param": param, "hex": h(tp.make_cmd(cmd, param))}
        for (name, cmd, param) in [
            ("CHECK_DEVICE", tp.CMD_CHECK_DEVICE, 0),
            ("INQUIRY_STA", tp.CMD_INQUIRY_STA, 0),
            ("INQUIRY_param", tp.CMD_INQUIRY_STA, 0x1234),
            ("START_PRINT", tp.CMD_START_PRINT, 0),
            ("STOP_PRINT", tp.CMD_STOP_PRINT, 0),
            ("RETURN_MAT", tp.CMD_RETURN_MAT, 0),
            ("PAPER_SKIP", tp.CMD_PAPER_SKIP, 5),
        ]
    ]

    out["startTrans"] = [
        {"cmd": cmd, "blockSize": bs, "blockCount": bc,
         "hex": h(tp.make_cmd_start_trans(cmd, bs, bc))}
        for (cmd, bs, bc) in [
            (tp.CMD_NEXT_ZIPPEDBULK, 512, 3),
            (tp.CMD_NEXT_ZIPPEDBULK, 512, 1),
            (tp.CMD_BUF_FULL, 1234, 60),
            (tp.CMD_BUF_FULL, 3210, 10),
        ]
    ]

    # --- data packets ---
    def chunk(pattern, n):
        return bytes((pattern + i) & 0xFF for i in range(n))

    out["dataPackets"] = []
    for (data, idx, tot) in [
        (b"\x42" * 500, 0, 3),
        (b"\xFF" * 100, 2, 5),
        (chunk(0, 500), 1, 3),
        (chunk(7, 250), 4, 5),
        (b"", 0, 1),
    ]:
        out["dataPackets"].append({
            "chunkHex": h(data), "idx": idx, "total": tot,
            "hex": h(tp.make_data_packet(data, idx, tot)),
        })

    out["wrapFrames"] = [
        {"payloadHex": h(p), "hex": h(tp.wrap_data_frame(p))}
        for p in [b"\xAA" * 506, chunk(3, 506)]
    ]

    # buildDataFrames: whole-stream framing (ported as list of 512B frames)
    def build_frames(compressed):
        num = (len(compressed) + 499) // 500
        frames = []
        for i in range(num):
            ch = compressed[i * 500:(i + 1) * 500]
            frames.append(tp.wrap_data_frame(tp.make_data_packet(ch, i, num)))
        return frames

    out["buildDataFrames"] = []
    for comp in [chunk(0, 1100), chunk(9, 500), chunk(1, 1)]:
        out["buildDataFrames"].append({
            "compressedHex": h(comp),
            "count": (len(comp) + 499) // 500,
            "framesHex": [h(f) for f in build_frames(comp)],
        })

    # --- page reg bits ---
    out["pageRegBits"] = []
    for args in [
        dict(nodu=4, mat=1),
        dict(page_st=1, page_end=1, prt_end=1, nodu=4, mat=1),
        dict(page_st=1, nodu=15, mat=1),
        dict(cut=3, savepaper=1, first_cut=2, nodu=7, mat=2),
    ]:
        out["pageRegBits"].append({"args": args, "hex": h(tp.build_page_reg_bits(**args))})

    # --- print buffers ---
    out["printBuffers"] = []
    for params in [
        dict(per_line_byte=48, cols_in_buf=84, page_st=True, page_end=True,
             prt_end=True, margin_top=8, margin_bottom=8, density=4),
        dict(per_line_byte=48, cols_in_buf=40, page_st=True, page_end=False,
             prt_end=False, margin_top=8, margin_bottom=8, density=7),
        dict(per_line_byte=12, cols_in_buf=100, page_st=False, page_end=True,
             prt_end=True, margin_top=2, margin_bottom=2, density=4),
    ]:
        img = chunk(1, params["cols_in_buf"] * params["per_line_byte"])
        buf = tp.build_print_buffer(img, **params)
        out["printBuffers"].append({
            "params": params, "imageDataHex": h(img), "hex": h(buf),
        })

    # --- calc speed thresholds ---
    out["calcSpeed"] = [
        {"size": s, "speed": tp.calc_speed(s)}
        for s in [4000, 3001, 3000, 2801, 2800, 2500, 2000, 1500, 1000, 501, 500, 100, 0]
    ]

    # --- parse status ---
    out["parseStatus"] = []
    for (b14, b15, b16, b17, cnt) in [
        (0, 0, 0x40, 0, 0),
        (0x02, 0, 0x08, 0x01, 5),
        (0x01, 0x04, 0, 0, 7),
        (0x7F, 0x0C, 0x58, 0x01, 65535),
    ]:
        frame = status_frame(b14, b15, b16, b17, cnt)
        out["parseStatus"].append({"inputHex": h(frame), "expected": tp.parse_status(frame)})
    # invalid frames -> None
    out["parseStatusNull"] = [h(bytes(10)), h(bytearray([0] + [0] * 19))]

    # --- parse material ---
    out["parseMaterial"] = []
    for kw in [
        dict(width=12, height=40, gap=2),
        dict(width=15, height=6, gap=0, remind=1234),
        dict(width=48, height=25, gap=3, sn=0xABCD, remind=100000),
    ]:
        frame = material_frame(**kw)
        out["parseMaterial"].append({"inputHex": h(frame), "expected": tp.parse_material(frame)})

    # --- test patterns (byte-exact reference image) ---
    out["testPatterns"] = []
    for (lw, hm) in [(40, 30), (12, 20), (15, 12)]:
        with muted():
            data, w, ht, bpl = tp.create_test_pattern(lw, hm, tp.DPI)
        out["testPatterns"].append({
            "labelWidthMm": lw, "heightMm": hm, "dpi": tp.DPI,
            "canvasWidthDots": w, "heightDots": ht, "bytesPerLine": bpl,
            "dataHex": h(data),
        })

    # --- LZMA alone header + size patch ---
    out["lzma"] = []
    for data in [bytes(4096), b"\x42" * 1024, chunk(0, 8192)]:
        raw, patched = lzma_alone(data)
        out["lzma"].append({
            "inputLen": len(data),
            "rawHex": h(raw),
            "patchedHex": h(patched),
        })

    # end-to-end job speed sanity: build buffers from a pattern, compress, speed
    with muted():
        img, w, ht, bpl = tp.create_test_pattern(40, 30, tp.DPI)
    margin = 8
    max_cols = tp.MAX_BUF_DATA // bpl
    image_cols = ht - 2 * margin
    raw_buffers = []
    cols_remaining, cur = image_cols, 0
    while cols_remaining > 0:
        cib = min(cols_remaining, max_cols)
        is_first = cur == 0
        is_last = cols_remaining <= max_cols
        s = (margin + cur) * bpl
        e = s + cib * bpl
        raw_buffers.append(tp.build_print_buffer(
            img[s:e], bpl, cib, page_st=is_first, page_end=is_last,
            prt_end=is_last, margin_top=margin, margin_bottom=margin, density=4))
        cur += cib
        cols_remaining -= cib
    concat = b"".join(raw_buffers)
    _, comp = lzma_alone(concat)
    out["job40x30"] = {
        "labelWidthMm": 40, "heightMm": 30, "density": 4,
        "canvasWidthDots": w, "bytesPerLine": bpl, "totalCols": ht,
        "marginTop": margin, "marginBottom": margin,
        "bufferCount": len(raw_buffers),
        "buffersHex": [h(b) for b in raw_buffers],
        "concatHex": h(concat),
        "compressedHex": h(comp),
        "compressedLen": len(comp),
        "avgPerBuffer": len(comp) / len(raw_buffers),
        "speed": tp.calc_speed(int(len(comp) / len(raw_buffers))),
    }

    return out


if __name__ == "__main__":
    json.dump(gen(), sys.stdout)
    sys.stdout.write("\n")
