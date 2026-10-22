#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Generate the GBK/GB18030 two-byte full mapping table for taprint-dart.

Enumerates every two-byte sequence of the GB18030 two-byte region
(lead byte 0x81-0xFE, trail byte 0x40-0x7E / 0x80-0xFE, 0x7F excluded)
and decodes each pair with Python's built-in ``gb18030`` codec. Every
decoded code point is re-encoded and asserted to round-trip to the same
bytes, pinning a bijective code-point -> bytes table.

Outputs (both regenerated deterministically, run from the repo root or
anywhere; paths resolve relative to this script):

* ``packages/taprint-dart/lib/src/printers/gbk_full.dart``
  ``const Map<int, int> gbkFullTable`` — code point -> packed two bytes
  (high 8 bits = lead byte), sorted by code point.

* ``packages/taprint-dart/test/fixtures_gbk_oracle.json``
  Oracle vectors consumed by ``test/printers/gbk_full_test.dart``:
  full-table sha256 (canonical line form), boundary vectors, curated
  business-glyph vectors, unmappable code points (no two-byte mapping),
  and decode-policy vectors (bytes outside the table decode to U+FFFD).

The replacement policy pinned here (ADR-0009):
encode keeps ASCII (< 0x80) as-is and replaces unmapped characters with
a single fallback byte (default ``?`` / 0x3F); decode replaces byte
pairs outside the table (and truncated tails) with U+FFFD.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DART_OUT = REPO_ROOT / "packages/taprint-dart/lib/src/printers/gbk_full.dart"
ORACLE_OUT = REPO_ROOT / "packages/taprint-dart/test/fixtures_gbk_oracle.json"

LEAD_RANGE = range(0x81, 0xFF)  # 0x81..0xFE


def trail_range():
    for trail in range(0x40, 0xFF):  # 0x40..0xFE
        if trail == 0x7F:
            continue
        yield trail


def build_table():
    """Decode every two-byte pair; assert bijective round-trip per entry."""
    table = {}
    for lead in LEAD_RANGE:
        for trail in trail_range():
            raw = bytes((lead, trail))
            char = raw.decode("gb18030")
            cp = ord(char)
            assert chr(cp).encode("gb18030") == raw, (
                f"round-trip mismatch at {raw.hex()} -> U+{cp:04X}")
            assert cp not in table, f"duplicate code point U+{cp:04X}"
            assert cp < 0x10000, f"unexpected astral cp U+{cp:04X}"
            table[cp] = (lead << 8) | trail
    return table


def canonical_payload(table):
    """'<CP-hex4>:<LEAD-hex2><TRAIL-hex2>\\n' per entry, sorted by code point.

    Both the Python oracle and the Dart test rebuild this exact ASCII
    payload; its sha256 proves full-table equality without shipping a
    24k-entry JSON vector list.
    """
    lines = [
        f"{cp:04X}:{packed >> 8:02X}{packed & 0xFF:02X}\n"
        for cp, packed in sorted(table.items())
    ]
    return "".join(lines)


# Curated glyphs: business vocabulary actually exercised by the receipt and
# label golden tests, plus full-width punctuation, kana, currency sign and
# the PUA block edges (GBK legacy unassigned positions mapped to PUA).
CURATED_CHARS = (
    "收银小票销售单商品数量金额日期客户业务员"
    "合计实收优惠找零支付方式谢谢惠顾，欢迎再次光临！"
    "产地货位货架标签规格名称单价零钱万千百十元角块房"
    "苹果香蕉鲜牛奶盒入库出库调拨采购退货换签款交备注"
    "红包总市场票经营网店仓位点装箱重项目资源打印机"
    "小便携热敏纸例如下中宽高现已自动不能请确认失败"
    "成功继续完房间地址电话企业壹贰叁肆伍陆柒捌玖"
    "。，、：；！？（）《》【】—…·「」『』"
    "あいうアイウ欧羅 metre™®©°±×÷"
    "ＡＢＧＭＮａｂｇｍｎ０１２９" "€"
)


def vector_entry(table, cp):
    packed = table[cp]
    return {
        "cp": cp,
        "bytes": f"{packed >> 8:02X}{packed & 0xFF:02X}",
        "char": chr(cp),
    }


def build_vectors(table):
    vectors = []
    # Region boundaries in byte space.
    vectors.append(vector_entry(table, ord(b"\x81\x40".decode("gb18030"))))
    vectors.append(vector_entry(table, ord(b"\x81\x7E".decode("gb18030"))))
    vectors.append(vector_entry(table, ord(b"\x81\x80".decode("gb18030"))))
    vectors.append(vector_entry(table, ord(b"\xFE\xFE".decode("gb18030"))))
    # Code-point extremes and block edges.
    cp_sorted = sorted(table)
    vectors.append(vector_entry(table, cp_sorted[0]))
    vectors.append(vector_entry(table, cp_sorted[-1]))
    pua = [cp for cp in cp_sorted if 0xE000 <= cp <= 0xF8FF]
    vectors.append(vector_entry(table, pua[0]))
    vectors.append(vector_entry(table, pua[-1]))
    cjk_basic = [cp for cp in cp_sorted if 0x4E00 <= cp <= 0x9FFF]
    vectors.append(vector_entry(table, cjk_basic[0]))
    vectors.append(vector_entry(table, cjk_basic[-1]))
    # Curated glyphs (skip ones already covered to keep the file tidy).
    seen = {v["cp"] for v in vectors}
    for char in CURATED_CHARS:
        cp = ord(char)
        if cp in table and cp not in seen:
            vectors.append(vector_entry(table, cp))
            seen.add(cp)
    return vectors


# Code points that have NO two-byte GB18030 mapping (four-byte-only region
# or beyond). Encode must fall back to the replacement byte, not throw.
UNMAPPABLE_CPS = [
    (0x0080, "C1 control byte, outside GB18030 two-byte region"),
    (0x00E9, "é — Latin-1 letter, four-byte gb18030 only"),
    (0x2600, "☀ — miscellaneous symbol, four-byte only"),
    (0x2E80, "CJK Radicals Supplement block start, four-byte only"),
    (0x3400, "CJK Extension A start, four-byte only"),
    (0xAC00, "가 — Hangul syllable, four-byte only"),
    (0xD7B0, "Hangul Jungseong block, four-byte only"),
    (0xFFFD, "U+FFFD itself encodes as 8431A437 (four bytes)"),
    (0x1F1E6, "regional indicator, outside gb18030 two-byte region"),
    (0x1F600, "emoji, astral plane"),
    (0x20000, "CJK Extension B, astral plane"),
]

# Decode-policy vectors: bytes without a table entry decode to U+FFFD
# (one U+FFFD per invalid pair; a truncated trailing lead is one U+FFFD;
# ASCII bytes always pass through).
INVALID_DECODE = [
    {"bytes": "81", "expected": "\ufffd",
     "note": "truncated trailing lead byte"},
    {"bytes": "8130", "expected": "\ufffd",
     "note": "trail byte below 0x40"},
    {"bytes": "817F", "expected": "\ufffd",
     "note": "trail byte 0x7F is not in the two-byte region"},
    {"bytes": "8040", "expected": "\ufffd",
     "note": "lead byte 0x80 is not in the two-byte region"},
    {"bytes": "FF41", "expected": "\ufffd",
     "note": "lead byte 0xFF is not in the two-byte region"},
    {"bytes": "41817F42", "expected": "A\ufffdB",
     "note": "ASCII passthrough around an invalid pair"},
    {"bytes": "411B4042", "expected": "A\x1b@B",
     "note": "pure ASCII control bytes pass through unchanged"},
]


def write_dart(table, payload_sha, vectors):
    lines = [
        "// SPDX-License-Identifier: Apache-2.0",
        "// GBK/GB18030 双字节区全表 —— 本文件由 tools/gen_gbk_table.py 自动生成，"
        "勿手改。",
        "// 生成口径：枚举双字节区全部序列（首字节 0x81-0xFE，次字节",
        "// 0x40-0x7E / 0x80-0xFE，不含 0x7F），以 Python 内建 gb18030 codec",
        "// 逐对解码并回编码校验双射；共 "
        f"{len(table)} 项（含 GBK 未定义位映射的 PUA 区），按码点升序。",
        "// 再生成：python3 tools/gen_gbk_table.py（同时产出 oracle 向量",
        "// test/fixtures_gbk_oracle.json，全表 sha256 = "
        f"{payload_sha[:16]}…）。",
        "// 表值打包：高 8 位 = 首字节，低 8 位 = 次字节。消费方为",
        "// gbk_codec.dart 的 [GbkFullCodec]（编码器默认通道）。",
        "",
        "/// GB18030 双字节区全表规模（码点数；与 oracle tableSize 一致）。",
        f"const int gbkFullTableSize = {len(table)};",
        "",
        "/// Unicode 码点 → GB18030 双字节（打包 int：高 8 位首字节、低 8 位次字节）。",
        "const Map<int, int> gbkFullTable = {",
    ]
    for cp, packed in sorted(table.items()):
        lines.append(f"  0x{cp:04X}: 0x{packed:04X},")
    lines.append("};")
    lines.append("")
    DART_OUT.parent.mkdir(parents=True, exist_ok=True)
    DART_OUT.write_text("\n".join(lines), encoding="utf-8", newline="\n")


def write_oracle(table, payload_sha, vectors):
    doc = {
        "generator": "tools/gen_gbk_table.py",
        "oracle": (
            "python3 built-in gb18030 codec; two-byte region brute force "
            "(lead 0x81-0xFE, trail 0x40-0x7E/0x80-0xFE), per-pair "
            "encode round-trip asserted"
        ),
        "tableSize": len(table),
        "tableSha256": payload_sha,
        "canonicalForm": (
            "one ASCII line per entry '<CP:4-hex-uppercase>:"
            "<LEAD:2-hex><TRAIL:2-hex>' LF-terminated, entries sorted by "
            "code point; sha256 over the UTF-8 (ASCII) bytes"
        ),
        "vectors": vectors,
        "unmappable": [
            {"cp": cp, "char": chr(cp), "note": note}
            for cp, note in UNMAPPABLE_CPS
        ],
        "invalidDecode": INVALID_DECODE,
    }
    ORACLE_OUT.parent.mkdir(parents=True, exist_ok=True)
    ORACLE_OUT.write_text(
        json.dumps(doc, ensure_ascii=True, indent=2, sort_keys=False) + "\n",
        encoding="utf-8", newline="\n")


def main() -> int:
    table = build_table()
    payload = canonical_payload(table)
    payload_sha = hashlib.sha256(payload.encode("ascii")).hexdigest()
    vectors = build_vectors(table)
    write_dart(table, payload_sha, vectors)
    write_oracle(table, payload_sha, vectors)
    print(f"gbk_full.dart: {len(table)} entries, "
          f"sha256={payload_sha}")
    print(f"oracle vectors: {len(vectors)} mapped, "
          f"{len(UNMAPPABLE_CPS)} unmappable, "
          f"{len(INVALID_DECODE)} decode-policy")
    print(f"dart size: {DART_OUT.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
