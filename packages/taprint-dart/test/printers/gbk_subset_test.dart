// SPDX-License-Identifier: Apache-2.0
// GBK 子集表（fast path）与全表的一致性锁定：子集表每项必须与
// gbk_full.dart 全表逐字节一致（同名 char 在两通道产出相同字节——
// 通道可换、字节不变的契约，ADR-0009）。另钉子集通道自身语义。

import 'package:taprint/printers.dart';
import 'package:test/test.dart';

void main() {
  group('gbkTable ⊆ gbkFullTable（fast path 字节一致）', () {
    test('子集表每项与全表逐字节相同', () {
      expect(gbkTable.length, lessThan(gbkFullTableSize),
          reason: '子集表只是 fast path，规模必小于全表');
      for (final e in gbkTable.entries) {
        expect(e.value.length, 2, reason: '子集表项恒为双字节');
        expect(gbkFullTable[e.key], (e.value[0] << 8) | e.value[1],
            reason: 'U+${e.key.toRadixString(16).toUpperCase()} '
                '子集/全表字节分叉');
      }
    });

    test('oracle 锚点字：收/银/中/谢谢惠顾（两通道同字节）', () {
      const subset = GbkCodec();
      const full = GbkFullCodec();
      const s = '收银中';
      expect(subset.encode(s), full.encode(s));
      expect(subset.encode(s), [0xCA, 0xD5, 0xD2, 0xF8, 0xD6, 0xD0]);
    });
  });

  group('GbkCodec 子集通道语义', () {
    const gbk = GbkCodec();

    test('ASCII 原样单字节', () {
      expect(gbk.encode('ABC 123'), 'ABC 123'.codeUnits);
    });

    test('子集表外、全表表内字符折 ?（覆盖率差异的既定行为）', () {
      // あ在全表内（A4A2）但不在子集表内 → 子集折 ?，全表正常双字节。
      expect(gbk.encode('あ'), const [0x3F]);
      expect(const GbkFullCodec().encode('あ'), const [0xA4, 0xA2]);
    });

    test('表外字符折 ?（默认 fallbackChar = 0x3F）', () {
      expect(gbk.encode('\u{1F600}'), const [0x3F]);
      expect(gbk.encode('a\u{1F600}b'), const [0x61, 0x3F, 0x62]);
    });

    test('自定义 fallbackChar', () {
      expect(const GbkCodec(fallbackChar: 0x20).encode('\u{1F600}'),
          const [0x20]);
    });

    test('isGbkLike = true', () {
      expect(gbk.isGbkLike, isTrue);
    });
  });
}
