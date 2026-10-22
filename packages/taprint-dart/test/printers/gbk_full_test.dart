// SPDX-License-Identifier: Apache-2.0
// GB18030 双字节区全表 oracle 锁定测试（ADR-0009：覆盖率由 oracle 生成，
// 不手写）。oracle = test/fixtures_gbk_oracle.json（生成器
// tools/gen_gbk_table.py，以 Python gb18030 codec 全区枚举 + 逐对回编
// 校验产出）。
//
// 四层断言：
// ① 规模与 sha256：全表逐项重建 canonical 行串后哈希，与 oracle
//    tableSha256 一致——证明 23,940 项**全表**与生成器真值逐项相同
//    （无需把全表复制进 JSON）；
// ② 抽样向量：oracle vectors（边界 + 业务字 + PUA 端点）逐条
//    encode/decode 断言；
// ③ 不可映射点：oracle unmappable 码点不在表内，encode 折 fallback
//    字节（'?'）且不抛；
// ④ 解码策略：表外字节对/截断尾 → U+FFFD（oracle invalidDecode）。

import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:taprint/printers.dart';
import 'package:test/test.dart';

import '../helpers/repo_paths.dart';

void main() {
  final oracle = readRawJson('packages/taprint-dart/test/fixtures_gbk_oracle.json')
      as Map<String, Object?>;
  final codec = const GbkFullCodec();

  /// 与生成器 canonical_payload 同构：按码点升序逐项拼
  /// '<CP:4hex>:<LEAD:2hex><TRAIL:2hex>\n'，sha256 作用于 ASCII（UTF-8
  /// 同字节）串。
  String canonicalOf(Map<int, int> table) {
    final entries = table.entries.toList()
      ..sort((a, b) => a.key.compareTo(b.key));
    final buf = StringBuffer();
    for (final e in entries) {
      buf
        ..write(e.key.toRadixString(16).toUpperCase().padLeft(4, '0'))
        ..write(':')
        ..write(((e.value >> 8) & 0xFF)
            .toRadixString(16)
            .toUpperCase()
            .padLeft(2, '0'))
        ..write((e.value & 0xFF)
            .toRadixString(16)
            .toUpperCase()
            .padLeft(2, '0'))
        ..write('\n');
    }
    return buf.toString();
  }

  group('GbkFullCodec 全表 oracle 锁定', () {
    test('① 全表规模与 sha256 与 oracle 一致（23,940 项逐项证明）', () {
      expect(gbkFullTable.length, oracle['tableSize']);
      expect(gbkFullTableSize, oracle['tableSize']);
      expect(gbkFullTableSize, 23940, reason: '双字节区 126×190 全覆盖');
      final digest = sha256.convert(utf8.encode(canonicalOf(gbkFullTable)));
      expect(digest.toString(), oracle['tableSha256'],
          reason: '全表 canonical 形态哈希与生成器真值一致');
    });

    test('② oracle 抽样向量：encode 逐字节 + decode 回查', () {
      final vectors = (oracle['vectors'] as List).cast<Map<String, Object?>>();
      expect(vectors.length, greaterThan(100), reason: '抽样面足够宽');
      for (final v in vectors) {
        final cp = v['cp']! as int;
        final bytesHex = v['bytes']! as String;
        final char = String.fromCharCode(cp);
        expect(gbkFullTable[cp], int.parse(bytesHex, radix: 16),
            reason: 'U+${cp.toRadixString(16).toUpperCase()} 表值一致');
        expect(codec.encode(char), hexBytes(bytesHex),
            reason: 'U+${cp.toRadixString(16).toUpperCase()} encode');
        expect(codec.decode(hexBytes(bytesHex)), char,
            reason: 'U+${cp.toRadixString(16).toUpperCase()} decode');
      }
    });

    test('② 边界锚点：首/末字节对（8140=丂、FEFE=PUA E4C5）', () {
      // 首字节对 8140 与末字节对 FEFE（oracle vectors 头四条）。
      expect(codec.decode(hexBytes('8140')), '\u4E02'); // 丂
      expect(codec.encode('\u4E02'), hexBytes('8140'));
      expect(codec.encode('\uE4C5'), hexBytes('FEFE')); // PUA 末位
      final vectors = (oracle['vectors'] as List).cast<Map<String, Object?>>();
      final cps = vectors.map((v) => v['cp']! as int).toSet();
      expect(cps, containsAll(<int>[0x4E02, 0xE4C5, 0xE000, 0xE864]),
          reason: '字节区端点与 PUA 端点须在抽样向量内');
    });

    test('③ oracle 不可映射点：表外码点 encode 折 fallback 字节且不抛', () {
      final unmappable =
          (oracle['unmappable'] as List).cast<Map<String, Object?>>();
      expect(unmappable.length, greaterThanOrEqualTo(10));
      for (final u in unmappable) {
        final cp = u['cp']! as int;
        expect(gbkFullTable.containsKey(cp), isFalse,
            reason: 'U+${cp.toRadixString(16).toUpperCase()} 应在表外'
                '（${u['note']}）');
        expect(codec.encode(String.fromCharCode(cp)), const [0x3F],
            reason: 'U+${cp.toRadixString(16).toUpperCase()} → fallback ?');
      }
    });

    test('④ oracle 解码策略：表外字节对/截断尾 → U+FFFD；ASCII 原样', () {
      final cases =
          (oracle['invalidDecode'] as List).cast<Map<String, Object?>>();
      for (final c in cases) {
        expect(codec.decode(hexBytes(c['bytes']! as String)), c['expected'],
            reason: c['note']! as String);
      }
    });

    test('基础语义：ASCII 原样单字节；空串零字节；混合串', () {
      expect(codec.encode(''), isEmpty);
      expect(codec.encode('ABC-123'), 'ABC-123'.codeUnits);
      // 中英混排：收=CA D5、银=D2 F8（与 oracle 向量同源锚点）
      expect(codec.encode('收银 CAD5'),
          [0xCA, 0xD5, 0xD2, 0xF8, 0x20, 0x43, 0x41, 0x44, 0x35]);
      // 表内表外混排逐字符折 '?'
      expect(codec.encode('a\u{1F600}b'), [0x61, 0x3F, 0x62]);
    });

    test('isGbkLike = true（ESC/POS 通道据此发汉字模式指令）', () {
      expect(codec.isGbkLike, isTrue);
    });
  });
}
