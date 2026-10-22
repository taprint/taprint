// SPDX-License-Identifier: Apache-2.0
// 仓库根定位（测试辅助）：从 Directory.current（包目录）向上回溯，
// 以 fixtures/templates/message-signer-v1.json + fixture-manifest 产物为锚点。
// 跨语言一致性锚点文件从仓根 fixtures/ 只读消费（）。

import 'dart:convert';
import 'dart:io';

import 'package:taprint/print_dsl.dart';

Directory findRepoRoot() {
  var dir = Directory.current.absolute;
  for (;;) {
    final fixture = File('${dir.path}/fixtures/templates/message-signer-v1.json');
    final manifest =
        File('${dir.path}/packages/taprint-ts/tests/generated/fixture-manifest.json');
    if (fixture.existsSync() && manifest.existsSync()) return dir;
    final parent = dir.parent;
    if (parent.path == dir.path) {
      throw StateError('未找到仓库根（自 ${Directory.current} 上溯无 fixtures 锚点）');
    }
    dir = parent;
  }
}

final Directory repoRoot = findRepoRoot();

/// 读仓根相对路径的 JSON 为对象树（经 DslParser.parse：BOM 剥离 + 数字归一 double，
/// 镜像 JS JSON.parse——TS/C# 测试 readJson 的同构口径）。
Map<String, Object?> readJson(String rel) =>
    DslParser.parse(File('${repoRoot.path}/$rel').readAsStringSync());

String readText(String rel) => File('${repoRoot.path}/$rel').readAsStringSync();

Object? readRawJson(String rel) =>
    jsonDecode(File('${repoRoot.path}/$rel').readAsStringSync());

/// 权威 schema 以原始 jsonDecode 加载（不做 int→double 归一）：json_schema 包要求
/// minLength/maxItems 等 schema 参数为 Dart int（与 Ajv 消费 JS number 的口径分叉，
/// 仅测试装载路径相关，不影响实例校验语义）。
Map<String, Object?> schemaV1() =>
    (readRawJson('schema/v1.0.json') as Map).cast<String, Object?>();

Map<String, Object?> schemaV11() =>
    (readRawJson('schema/v1.1.json') as Map).cast<String, Object?>();

/// fixtures/templates 下按后缀列举业务 fixture 文件名（排序稳定）。
List<String> listFixtureFiles(String suffix) =>
    Directory('${repoRoot.path}/fixtures/templates')
        .listSync()
        .whereType<File>()
        .map((f) => f.uri.pathSegments.last)
        .where((name) => name.endsWith(suffix))
        .toList()
      ..sort();

Map<String, Object?> schemaV2() =>
    (readRawJson('schema/v2.0.json') as Map).cast<String, Object?>();

List<int> hexBytes(String s) => [
      for (var i = 0; i < s.length; i += 2) int.parse(s.substring(i, i + 2), radix: 16),
    ];
