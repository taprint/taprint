// SPDX-License-Identifier: Apache-2.0
// DSL 版本迁移 Dart 端（与 TS/C#/Java 同构）。
// - 版本链为有序注册表：内置 0.9 → 1.0（DSL 定稿前模板无 schemaVersion 字段，视为 0.9；
//   hiprint 迁移入口即此路径）→ 1.1（label 域字段约定统一：仅折算 text.size 0 折 1 与
//   qrcode.size >10 折 10，其余保字段）→ 2.0（中国式报表专项步骤 3：v2.0 为 1.x 严格超集，
//   步骤仅推进版本声明，结构兼容由「全部 v1.0 fixture 迁移后通过 v2.0 schema」锚点锁定）；
//   registerStep 可扩展自定义版本；
// - migrate 逐级执行步骤，每步结束断言 schemaVersion 被置为链上下一版本；
//   可选注入 schema 时每步后过 DslValidator.validate 门禁（内核不内置文件路径）；
// - detectVersion：缺 schemaVersion 归 0.9，其余按 `主.次` 文法如实上报；
// - migrate 入口深拷贝隔离调用方入参（JSON 语义），from == to 为恒等迁移；
//   MigrationStep 契约：纯函数，禁改入参、须返回新对象。
// 异常映射（SPEC ）：版本文法非法 → FormatException；降级 → RangeError；
// 断链/步骤未推进/越过目标/schema 门禁失败 → StateError。

import 'dart:convert';

import 'dsl_validator.dart';
import 'internal/canonical.dart';

/// 版本文法：`主.次` 十进制数段（与 schema/changelog.md 版本列一致）。
final RegExp _versionRe = RegExp(r'^\d+\.\d+$');

/// 从旧版本逐级迁移到目标版本（）。入口深拷贝隔离入参；schema 注入时每步后
/// 经 DslValidator.validate 门禁；from == to 为恒等迁移（返回深拷贝）。
class DslMigrator {
  DslMigrator._();

  /// DSL 定稿前模板（无 schemaVersion 字段）的归档版本号。
  static const String legacyVersion = '0.9';

  /// 当前权威 schema 版本（schema/v2.0.json / schema/changelog.md，中国式报表专项）。
  static const String currentVersion = '2.0';

  static final Map<String, MigrationStep> _stepRegistry = {};

  static bool _builtinsRegistered = false;

  static void _registerBuiltins() {
    // 0.9 → 1.0：DSL 权威定稿（Phase 0）。结构兼容，仅补版本声明。
    _stepRegistry[legacyVersion] = (dsl) => {...dsl, 'schemaVersion': '1.0'};
    // 1.0 → 1.1：label 域字段约定统一（schema/changelog.md v1.1 行）。仅折算两处
    // 收窄值——text.size 0 折 1、qrcode.size >10 折 10（D4：PC 引擎与后端 TSPL
    // 渲染早已按 1-10 clamp，本步把存量文档折进新值域）；其余字段原样保留（保字段
    // 铁律：1.0 文档无 v1.1 新增字段，本步不产生也不丢失任何字段）。
    _stepRegistry['1.0'] = _normalizeLabelV11ThenBump;
    // 1.1 → 2.0：中国式报表专项步骤 3。v2.0 为 1.x 严格超集（v1.1 同批已把 label
    // 六元素/收窄落稿同步进 v2.0），步骤仅推进版本声明。
    _stepRegistry['1.1'] = (dsl) => {...dsl, 'schemaVersion': '2.0'};
    _builtinsRegistered = true;
  }

  /// 1.0 → 1.1 折算（纯函数，禁改入参嵌套对象）：遍历 presentations.label.body——
  /// text 元素 size==0 → 1（v1.1 钉死 1-10，0 折 1）；qrcode 元素 size>10 → 10
  /// （v1.1 收窄 1-10）。其余元素与字段一律原样保留。
  static Map<String, Object?> _normalizeLabelV11ThenBump(Map<String, Object?> dsl) {
    final copy = {...dsl, 'schemaVersion': '1.1'};
    final pres = copy['presentations'];
    if (pres is! Map<String, Object?>) return copy;
    final label = pres['label'];
    if (label is! Map<String, Object?>) return copy;
    final body = label['body'];
    if (body is! List<Object?>) return copy;
    final normalizedBody = body.map((el) {
      if (el is! Map<String, Object?>) return el;
      final type = el['type'];
      final size = el['size'];
      if (type == 'text' && size is num && size == 0) return {...el, 'size': 1};
      if (type == 'qrcode' && size is num && size > 10) return {...el, 'size': 10};
      return el;
    }).toList();
    final normalizedLabel = {...label, 'body': normalizedBody};
    copy['presentations'] = {...pres, 'label': normalizedLabel};
    return copy;
  }

  static Map<String, MigrationStep> get _steps {
    if (!_builtinsRegistered) _registerBuiltins();
    return _stepRegistry;
  }

  static int _compareVersions(String a, String b) {
    final pa = a.split('.').map(int.parse).toList();
    final pb = b.split('.').map(int.parse).toList();
    return pa[0] != pb[0] ? pa[0] - pb[0] : pa[1] - pb[1];
  }

  static String _normalizeVersion(String v, String label) {
    if (!_versionRe.hasMatch(v)) {
      throw FormatException('DslMigrator: $label 版本格式非法（须为 "主.次"）：$v');
    }
    return v;
  }

  /// 入口深拷贝：调用方入参与迁移产物完全隔离（JSON 语义，循环引用即拒）。
  static Map<String, Object?> _deepClone(Map<String, Object?> dsl) {
    try {
      final decoded = jsonDecode(jsonEncode(dsl));
      return (normalizeJsonNumbers(decoded) as Map).cast<String, Object?>();
    } on Object {
      throw ArgumentError('DslMigrator.migrate: dsl 必须为 JSON-safe（拒绝循环引用）');
    }
  }

  /// 从旧版本逐级迁移到目标版本。schema 门禁支持对象（单一门禁）与函数
  /// `Map<String, Object?> Function(String producedVersion)`（pattern 分轨链按步选
  /// schema——v1.0 中间产物过不了 `^2.x` pattern，函数形态放行）。
  static Map<String, Object?> migrate(
    Map<String, Object?> dsl,
    String fromVersion,
    String toVersion, {
    Object? schema,
  }) {
    final from = _normalizeVersion(fromVersion, 'fromVersion');
    final to = _normalizeVersion(toVersion, 'toVersion');
    if (_compareVersions(from, to) > 0) {
      throw RangeError('DslMigrator.migrate: 不支持降级迁移（$from → $to）');
    }
    var current = _deepClone(dsl);
    var version = from;
    while (_compareVersions(version, to) < 0) {
      final step = _steps[version];
      if (step == null) {
        throw StateError(
            'DslMigrator.migrate: 版本 $version 无已注册迁移步骤（迁移链断裂，目标 $to）');
      }
      current = Map.of(step(current));
      final next = current['schemaVersion'];
      if (next is! String || _compareVersions(next, version) <= 0) {
        throw StateError(
            'DslMigrator.migrate: $version 迁移步骤未将 schemaVersion 推进（得到 $next）');
      }
      if (_compareVersions(next, to) > 0) {
        throw StateError(
            'DslMigrator.migrate: $version 迁移步骤越过目标版本（推进至 $next，目标 $to）');
      }
      version = next;
      if (schema != null) {
        // 函数形态按该步产出版本选 schema（pattern 分轨链必需）；对象形态逐步同 schema
        final Object gateSchema;
        if (schema is Map<String, Object?>) {
          gateSchema = schema;
        } else if (schema is Map<String, Object?> Function(String)) {
          gateSchema = schema(version);
        } else {
          throw ArgumentError.value(
              schema, 'schema', 'schema 门禁须为 Map（对象形态）或 String→Map 函数（函数形态）');
        }
        final result = DslValidator.validate(current, gateSchema as Map<String, Object?>);
        if (!result.valid) {
          throw StateError(
              'DslMigrator.migrate: 迁移至 $version 后未通过 schema 校验：${result.errors.isNotEmpty ? result.errors.first.message : '未知错误'}');
        }
      }
    }
    return current;
  }

  /// 检测模板版本：缺 schemaVersion 归 0.9（定稿前模板）；否则按文法如实上报
  /// （合法性/可迁移性归 migrate 判定）。非对象抛 ArgumentError；文法非法抛 FormatException。
  static String detectVersion(Object? dsl) {
    if (dsl is! Map) {
      throw ArgumentError('DslMigrator: dsl 必须为对象');
    }
    final v = dsl['schemaVersion'];
    if (v == null) return legacyVersion;
    if (v is! String || !_versionRe.hasMatch(v)) {
      throw FormatException('DslMigrator.detectVersion: schemaVersion 不可识别：$v');
    }
    return v;
  }

  /// 注册迁移步骤（fromVersion → 步骤内声明的下一版本；重复注册覆写）。
  /// 风险声明：覆写内置 0.9 步骤会改变**所有**定稿前模板的迁移路径——生产环境仅在
  /// 有明确迁移策略变更时使用；clear() 可恢复内置链。
  static void registerStep(String fromVersion, MigrationStep step) {
    final from = _normalizeVersion(fromVersion, 'fromVersion');
    _steps[from] = step;
  }

  /// 恢复内置迁移链（0.9 → 1.0 → 1.1 → 2.0）；测试隔离 / 宿主生命周期用。
  static void clear() {
    _stepRegistry.clear();
    _registerBuiltins();
  }
}

/// 迁移步骤契约：纯函数——禁止原地修改入参（含嵌套对象），必须返回新对象。
typedef MigrationStep = Map<String, Object?> Function(Map<String, Object?> dsl);
