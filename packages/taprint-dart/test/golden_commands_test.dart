// SPDX-License-Identifier: Apache-2.0
// ADR-0010 golden 分层 Dart runner（脚本就绪 · 标注未启用）。
//
// 现状：Dart 侧编码器面（lib/src/printers/ tspl_encoder/cpcl_encoder/
// escpos_encoder）与 canonical 用例模型（fixtures/cases，schema
// taprint/golden-case@1）的映射已具形——首版接线只做「就绪+标注」（本仓约定），
// 全部用例以 skip 登记，待 docs/conformance.md 中 Dart 差异清单（行尾 LF、
// 表外字符 question 档、GB18030 全表通道等）过评审后逐协议启用断言。
// 启用路径：去掉 group 的 skip 参数 → 按 fixtures/README.md §runner 跑
// dart test test/golden_commands_test.dart。

import 'dart:convert';
import 'dart:io';

import 'package:taprint/printers.dart';
import 'package:test/test.dart';

import 'helpers/repo_paths.dart';

void main() {
  final manifest = readJson('fixtures/manifest.json');
  final entries = (manifest['cases'] as List).cast<Map>();
  final commandsRoot = '${repoRoot.path}/fixtures/expected/commands';

  group(
    'ADR-0010 golden commands（Dart runner · 未启用）',
    () {
      test('manifest 装载完整（≥40 用例，分层策略自洽）', () {
        expect(entries.length, greaterThanOrEqualTo(40));
        for (final entry in entries) {
          expect((entry['layers'] as Map)['l1'], isTrue);
          if (entry['containsIdentityFn'] == true) {
            expect((entry['layers'] as Map)['l2'], isFalse,
                reason: '身份函数用例必须 L1-only（ADR-0007/0010）');
          }
        }
      });

      test('参照帧工件齐备（每用例×协议一份 frames.txt）', () {
        for (final entry in entries) {
          final id = entry['case'] as String;
          for (final protocol in (entry['protocols'] as List).cast<String>()) {
            final frames = File('$commandsRoot/$id/java/$protocol.frames.txt');
            expect(frames.existsSync(), isTrue,
                reason: '缺参照帧工件: ${frames.path}');
          }
        }
      });

      test('TSPL 帧序映射示范（SIZE→…→CLS→body→PRINT）', () {
        // 启用后：canonical 用例 → LabelSpec → TsplEncoder.encode →
        // frames.txt 同规则切帧 → 与 java 参照逐帧比对（差异进 conformance.md）。
        const spec = LabelSpec(
          widthMm: 60,
          heightMm: 40,
          body: [
            LabelElement(type: 'text', xMm: 4, yMm: 18, content: 'DART-RUNNER'),
          ],
        );
        final bytes = TsplEncoder().encode(spec, const {});
        final text = latin1.decode(bytes);
        expect(text, startsWith('SIZE 60mm,40mm'));
        expect(text.trimRight().endsWith('PRINT 1'), isTrue);
      });
    },
    skip: 'ADR-0010 首版接线：Java 参照 + TS runner 先行；Dart 启用前须按 '
        'docs/conformance.md 对齐（行尾 LF、表外字符档、GB18030 全表通道等）',
  );
}
