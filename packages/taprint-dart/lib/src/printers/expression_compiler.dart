// SPDX-License-Identifier: Apache-2.0
// 编码器表达式插值（收据/标签模板的内容求值入口）。
//
// 注意：与内核 src/expression_compiler.dart（JS 语义沙箱求值器）
// 同名不同物——本文件是**编码器配套的轻量插值子集**，只处理
// `{{ path | filter:arg }}` 占位符，语义如下：
// - path：嵌套字段（点号访问，如 `store.name`）；
// - filter：`date:'YYYY-MM-DD HH:mm'` / `currency:CNY`；
// - 求值失败 fallback 空串（编码不抛错，降级归调用方）。

/// 占位符插值器（静态工具类）。
class ExpressionCompiler {
  const ExpressionCompiler._();

  /// 按 path 取值；filter 链顺序应用。未知 filter 原样返回。
  static String eval(
    String expr,
    Map<String, dynamic> primary, {
    Map<String, List<Map<String, dynamic>>> details = const {},
  }) {
    final trimmed = expr.trim();
    final segments = _splitFilters(trimmed);
    final path = segments.first.trim();
    var value = _resolvePath(path, primary, details);
    for (var i = 1; i < segments.length; i++) {
      value = _applyFilter(value, segments[i].trim());
    }
    return value;
  }

  /// 解析 `{{ ... }}` 占位：求值后回填；非占位文本原样保留。
  static String interpolate(
    String template,
    Map<String, dynamic> primary, {
    Map<String, List<Map<String, dynamic>>> details = const {},
  }) {
    final regex = RegExp(r'\{\{([^}]+)\}\}');
    return template.replaceAllMapped(regex, (m) {
      return eval(m.group(1)!, primary, details: details);
    });
  }

  static List<String> _splitFilters(String expr) {
    // 简化分词：按 '|' 切。当前 filter 参数（日期格式、币种代码）不含
    // '|'，简化实现即可。
    return expr.split('|');
  }

  static String _resolvePath(
    String path,
    Map<String, dynamic> primary,
    Map<String, List<Map<String, dynamic>>> details,
  ) {
    if (path.isEmpty) return '';
    final first = path.split('.').first;
    if (details.containsKey(first)) {
      // 数据源引用：插值阶段不展开明细行（table 渲染在编码器内按
      // columnSpecs 单独迭代）；此处 fallback 空串。
      return '';
    }
    final parts = path.split('.');
    dynamic current = primary;
    for (final p in parts) {
      if (current is Map<String, dynamic>) {
        current = current[p];
      } else {
        return '';
      }
      if (current == null) return '';
    }
    if (current is num) {
      // num → 字符串（currency filter 会再加工）；过滤 .0 后缀
      if (current == current.toInt()) {
        return current.toInt().toString();
      }
      return current.toString();
    }
    return current?.toString() ?? '';
  }

  static String _applyFilter(String value, String filter) {
    final colonIdx = filter.indexOf(':');
    final name = (colonIdx >= 0 ? filter.substring(0, colonIdx) : filter).trim();
    final args = colonIdx >= 0 ? filter.substring(colonIdx + 1).trim() : '';
    switch (name) {
      case 'date':
        return _formatDate(value, _unquote(args));
      case 'currency':
        return _formatCurrency(value, _unquote(args));
      default:
        return value;
    }
  }

  static String _unquote(String s) {
    final t = s.trim();
    if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
      return t.substring(1, t.length - 1);
    }
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
      return t.substring(1, t.length - 1);
    }
    return t;
  }

  /// 日期格式：支持 'YYYY-MM-DD HH:mm' / 'YYYY-MM-DD' 两种模式
  ///（收据/标签 fixture 实际使用的格式）；其余模式回退 ISO 8601 输出。
  static String _formatDate(String value, String pattern) {
    if (value.isEmpty) return '';
    final parsed = DateTime.tryParse(value);
    if (parsed == null) return value;
    switch (pattern) {
      case 'YYYY-MM-DD':
        return '${parsed.year.toString().padLeft(4, '0')}-'
            '${parsed.month.toString().padLeft(2, '0')}-'
            '${parsed.day.toString().padLeft(2, '0')}';
      case 'YYYY-MM-DD HH:mm':
        return '${parsed.year.toString().padLeft(4, '0')}-'
            '${parsed.month.toString().padLeft(2, '0')}-'
            '${parsed.day.toString().padLeft(2, '0')} '
            '${parsed.hour.toString().padLeft(2, '0')}:'
            '${parsed.minute.toString().padLeft(2, '0')}';
      default:
        return parsed.toIso8601String();
    }
  }

  /// 货币格式：默认两位小数，无千分位。
  static String _formatCurrency(String value, String args) {
    final num n = num.tryParse(value) ?? 0;
    return n.toStringAsFixed(2);
  }
}
