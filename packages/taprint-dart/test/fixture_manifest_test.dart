// SPDX-License-Identifier: Apache-2.0
// fixture-manifest / golden-manifest 驱动遍历（SPEC  验收锚点；多语言实现一致性清单
// 消费方——manifest 为 fixture-codegen 产物，Dart 端只读遍历，与 C# FixtureManifestTests
// 同口径）。五门禁：parse / validate（按版本分轨）/ validateBusiness / v1→v2 超集 /
// parse-result 锚点逐字 + expected 文件 sha256 与 golden-manifest 逐字比对。

import 'package:taprint/print_dsl.dart';
import 'package:taprint/src/internal/canonical.dart';
import 'package:taprint/src/internal/crypto.dart';
import 'package:test/test.dart';

import 'helpers/repo_paths.dart';

void main() {
  final manifest =
      readJson('packages/taprint-ts/tests/generated/fixture-manifest.json');
  final golden = readJson('packages/taprint-ts/tests/generated/golden-manifest.json');

  final bizFixtures = (manifest['bizFixtures'] as List).cast<Map>();
  final signerFixtures = (manifest['signerFixtures'] as List).cast<Map>();
  final parserFixtures = (manifest['parserFixtures'] as List).cast<Map>();
  final migrationFixtures = (manifest['migrationFixtures'] as List).cast<Map>();

  Map<String, Object?> schemaFor(String version) => version.startsWith('2.')
      ? schemaV2()
      : version == '1.1'
          ? schemaV11()
          : schemaV1();

  Map<String, String> goldenShaByExpectedFile() => {
        for (final g in (golden['goldens'] as List).cast<Map>())
          g['expectedFile'] as String: g['expectedSha256'] as String,
      };

  // 与 tools/golden-check.ts 同口径：sha256 作用于黄金文件的 canonical JSON 串
  // （全深度 key 字典序 + 紧凑无空白 + ECMA 最短十进制数字），非文件原始字节。
  String canonicalShaOf(String rel) =>
      toHex(sha256Bytes(utf8Bytes(canonicalizeTree(readRawJson(rel)))));

  test('manifest 格式冻结检查：schema 与 dslSchemaVersions 字段存在', () {
    expect(manifest['schema'], 'taprint/fixture-manifest@1');
    final versions = (manifest['dslSchemaVersions'] as List).cast<String>();
    expect(versions, contains('1.0'));
    expect(versions, contains('1.1'));
    expect(versions, contains('2.0'));
  });

  test('T5：manifest.sha256 与 fixture 本体 canonical hash 逐字一致（版本+hash 锚定）', () {
    expect(bizFixtures, isNotEmpty);
    for (final item in bizFixtures) {
      final file = item['file'] as String;
      final expected = item['sha256'] as String;
      expect(canonicalShaOf('fixtures/templates/$file'), expected, reason: file);
    }
  });

  test('门禁①：全部 bizFixture 过 parse 返回非空对象树', () {
    expect(bizFixtures.length, greaterThanOrEqualTo(16));
    for (final item in bizFixtures) {
      final rel = item['relPath'] as String;
      final tree = readJson(rel);
      expect(tree, isNotEmpty, reason: rel);
    }
  });

  test('门禁②：全部 bizFixture 过对应版本 schema 校验', () {
    for (final item in bizFixtures) {
      final rel = item['relPath'] as String;
      final version = item['schemaVersion'] as String;
      final result = DslValidator.validate(readJson(rel), schemaFor(version));
      expect(result.errors, isEmpty, reason: '$rel (v$version)');
      expect(result.valid, isTrue, reason: rel);
    }
  });

  test('门禁③：全部 bizFixture 过 validateBusiness 无表达式/字段绑定错误', () {
    for (final item in bizFixtures) {
      final rel = item['relPath'] as String;
      final result = DslValidator.validateBusiness(readJson(rel));
      expect(result.errors.map((e) => '${e.code}@${e.path}'), isEmpty, reason: rel);
    }
  });

  test('门禁④：v1 bizFixture 迁移至 v2 后过 v2 schema（超集承诺锁定）', () {
    for (final item in bizFixtures) {
      if (item['schemaVersion'] != '1.0') continue;
      final rel = item['relPath'] as String;
      final migrated = DslMigrator.migrate(readJson(rel), '1.0', DslMigrator.currentVersion);
      final result = DslValidator.validate(migrated, schemaV2());
      expect(result.errors.map((e) => e.message), isEmpty, reason: '$rel 迁移后');
    }
  });

  group('门禁⑤：parse-result 锚点逐字 + golden sha256 比对', () {
    final shas = goldenShaByExpectedFile();

    test('parserFixtures 清单为 5 个锚点', () {
      expect(parserFixtures.length, 5);
    });

    for (final item in parserFixtures) {
      final rel = item['relPath'] as String;
      final expectedRel = item['expectedRelPath'] as String;
      test('$rel parseResult 与 expected-output 逐字一致', () {
        final dsl = readJson(rel);
        final version = dsl['schemaVersion'] as String;
        final expected = readJson(expectedRel);
        expect(DslParser.parseResult(dsl, schemaFor(version)).toJsonMap(), equals(expected));
      });
      test('$expectedRel sha256 与 golden-manifest 逐字一致', () {
        expect(canonicalShaOf(expectedRel), shas[expectedRel.split('/').last]);
      });
    }
  });

  group('signer 锚点：v1–v5 三字段逐字 + golden sha256 比对', () {
    final shas = goldenShaByExpectedFile();

    test('signerFixtures 清单为 5 个锚点', () {
      expect(signerFixtures.length, 5);
    });

    for (final item in signerFixtures) {
      final rel = item['relPath'] as String;
      final expectedRel = item['expectedRelPath'] as String;
      test('$rel keyBase64/canonical/signature 三字段逐字一致', () {
        final fixture = readJson(rel);
        final message = fixture['message']! as Map<String, Object?>;
        final expected = readJson(expectedRel);
        final key = MessageSigner.deriveMessageKey(fixture['sessionToken'] as String);
        expect(key, expected['keyBase64']);
        expect(MessageSigner.canonicalize(message), expected['canonical']);
        expect(MessageSigner.sign(message, key), expected['signature']);
      });
      test('$expectedRel sha256 与 golden-manifest 逐字一致', () {
        expect(canonicalShaOf(expectedRel), shas[expectedRel.split('/').last]);
      });
    }
  });

  group('migration 锚点：双 fixture 逐字 + golden sha256 比对', () {
    final shas = goldenShaByExpectedFile();

    test('migrationFixtures 清单为 2 个锚点（0.9→1.0 / 1.0→2.0）', () {
      expect(migrationFixtures.length, 2);
    });

    for (final item in migrationFixtures) {
      final rel = item['relPath'] as String;
      final expectedRel = item['expectedRelPath'] as String;
      final from = item['fromVersion'] as String;
      final to = item['toVersion'] as String;
      test('$rel migrate($from→$to) 与 expected-output 逐字一致', () {
        final migrated = DslMigrator.migrate(readJson(rel), from, to);
        expect(migrated, equals(readJson(expectedRel)));
      });
      test('$expectedRel sha256 与 golden-manifest 逐字一致', () {
        expect(canonicalShaOf(expectedRel), shas[expectedRel.split('/').last]);
      });
    }
  });
}
