// SPDX-License-Identifier: Apache-2.0
// 表达式编译/求值 Dart 端（print-dsl-cs ExpressionCompiler.cs 权威语义移植；
// 语义口径：主文档  JS 表达式 + Liquid 管道、 沙箱； 多语言实现一致锚点）。
// JS 语义复刻关键点（与 TS/C# 逐字对齐，不得 Dart 习惯化）：
// - toNumber('') = NaN（trim 守卫），而 looseEquals 走 numberFromString('') = 0（JS Number 语义），两口径分离；
// - Math.round 复刻为 floor(x + 0.5)（jsRound(-0.5) = -0；禁银行家舍入）；
// - toFixed ties 远离零（(−0.5).toFixed(0) = "-1"），|x| ≥ 1e21 回退 formatEcmaNumber；
// - 比较 < <= > >=：双字符串 UTF-16 code unit 字典序，否则双侧 toNumber（NaN 一律 false）；
// - '%' 为 JS 余数（符号随被除数）——Dart 内建 % 是欧氏模，手动复刻；
// - '+' 任一侧 string 即拼接（null/undefined → ""，数字经 formatEcmaNumber）；
// - date 过滤器取本地时区分量（与 JS getFullYear/getMonth… 一致），V8 ISO 子集 +
//   遗留格式保守收窄（SPEC  分叉②）。
import 'dart:math' as math;
import 'dart:typed_data';

import 'internal/ecma_number.dart';
import 'internal/js_date.dart';
import 'types.dart';

/// 表达式文法错误（携带记号位置；对应 TS ExpressionSyntaxError）。
class ExpressionSyntaxError implements Exception {
  final String message;

  /// 出错位置（字符下标；-1 表示无具体位置）。
  final int position;

  const ExpressionSyntaxError(this.message, this.position);

  @override
  String toString() => 'ExpressionSyntaxError: $message';
}

/// 沙箱限额（主文档 ）。
const int maxExprBytes = 1024;

/// AST 最大嵌套深度。
const int maxAstDepth = 64;

const List<String> _punct = [
  '===', '!==', '==', '!=', '<=', '>=', '&&', '||',
  '<', '>', '+', '-', '*', '/', '%', '!', '?', ':',
  '(', ')', '[', ']', '.', ',', '|',
];

/// 字符串转义白名单（二轮：多语言实现同构必须逐字复现，未列出的转义编译期即拒）。
const Map<String, String> _stringEscapes = {
  'n': '\n',
  't': '\t',
  'r': '\r',
  '\\': '\\',
  "'": "'",
  '"': '"',
};

/// 内置过滤器白名单（主文档  + default/avg/min/max；未知过滤器编译期即拒）。
const Set<String> _filters = {
  'date', 'currency', 'round', 'sum', 'avg', 'min', 'max',
  'count', 'truncate', 'mask', 'default',
};

/// 过滤器参数编译期类型契约。空数组 = 不允许参数；'any' = 不限类型。
const Map<String, List<String>> _filterArgRules = {
  'date': ['string?'],
  'currency': ['string?'],
  'round': ['number?'],
  'sum': ['string?'],
  'avg': ['string?'],
  'min': ['string?'],
  'max': ['string?'],
  'count': [],
  'truncate': ['number?'],
  'mask': ['string?'],
  'default': ['any?'],
};

/// date 格式合法占位符。
const List<String> _dateTokens = ['YYYY', 'MM', 'DD', 'HH', 'mm', 'ss'];

final RegExp _numRe = RegExp(r'\d+(\.\d+)?');
final RegExp _identRe = RegExp(r'[A-Za-z_$][A-Za-z0-9_$]*');
final RegExp _letterRunRe = RegExp(r'[A-Za-z]+');

// V8 接受面：月/日允许 1-2 位（"2026-1-1" 合法，V8 真值），
// 时/分/秒/时区保持 2 位补零（V8 ISO 严格），时区代码层校验放宽至 ±23:59（V8 实测）。
final RegExp _isoDateRe = RegExp(
    r'^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|z|[+-]\d{2}:?\d{2})?)?$');

enum _TokenKind { num, str, ident, punct }

class _Token {
  final _TokenKind kind;
  final Object value; // double | String
  final int pos;

  const _Token(this.kind, this.value, this.pos);
}

List<_Token> _tokenize(String src) {
  final tokens = <_Token>[];
  var i = 0;
  while (i < src.length) {
    final ch = src[i];
    if (ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r') {
      i++;
      continue;
    }
    final cu = src.codeUnitAt(i);
    if (cu >= 0x30 && cu <= 0x39) {
      final m = _numRe.matchAsPrefix(src, i)!;
      tokens.add(_Token(_TokenKind.num, double.parse(m.group(0)!), i));
      i += m.group(0)!.length;
      continue;
    }
    if (ch == "'" || ch == '"') {
      final quote = ch;
      final sb = StringBuffer();
      var j = i + 1;
      var closed = false;
      while (j < src.length) {
        if (src[j] == '\\' && j + 1 < src.length) {
          final mapped = _stringEscapes[src[j + 1]];
          if (mapped == null) {
            throw ExpressionSyntaxError('未知转义序列：\\${src[j + 1]}', i);
          }
          sb.write(mapped);
          j += 2;
          continue;
        }
        if (src[j] == quote) {
          closed = true;
          break;
        }
        sb.write(src[j]);
        j++;
      }
      if (!closed) throw ExpressionSyntaxError('字符串未闭合', i);
      tokens.add(_Token(_TokenKind.str, sb.toString(), i));
      i = j + 1;
      continue;
    }
    if ((cu >= 0x41 && cu <= 0x5A) ||
        (cu >= 0x61 && cu <= 0x7A) ||
        ch == '_' ||
        ch == r'$') {
      final m = _identRe.matchAsPrefix(src, i)!;
      tokens.add(_Token(_TokenKind.ident, m.group(0)!, i));
      i += m.group(0)!.length;
      continue;
    }
    String? punct;
    for (final p in _punct) {
      if (src.startsWith(p, i)) {
        punct = p;
        break;
      }
    }
    if (punct != null) {
      tokens.add(_Token(_TokenKind.punct, punct, i));
      i += punct.length;
      continue;
    }
    throw ExpressionSyntaxError('非法字符：$ch', i);
  }
  return tokens;
}

bool _isAsciiLetter(String c) {
  final cu = c.codeUnitAt(0);
  return (cu >= 0x41 && cu <= 0x5A) || (cu >= 0x61 && cu <= 0x7A);
}

void _checkDateFormat(String fmt, int pos) {
  var i = 0;
  while (i < fmt.length) {
    String? tok;
    for (final t in _dateTokens) {
      if (fmt.startsWith(t, i)) {
        tok = t;
        break;
      }
    }
    if (tok != null) {
      i += tok.length;
      continue;
    }
    if (_isAsciiLetter(fmt[i])) {
      final run = _letterRunRe.matchAsPrefix(fmt, i)!.group(0)!;
      throw ExpressionSyntaxError(
          'date 格式含未识别占位符 "$run"（合法占位符：YYYY/MM/DD/HH/mm/ss，大小写敏感）', pos);
    }
    i++;
  }
}

class _ParserState {
  final List<_Token> _tokens;
  int _i = 0;

  _ParserState(this._tokens);

  ExpressionNode parse() {
    final node = _parseFilters();
    if (_i < _tokens.length) {
      throw ExpressionSyntaxError('表达式存在未消费的记号', _tokens[_i].pos);
    }
    return node;
  }

  _Token? _peek() => _i < _tokens.length ? _tokens[_i] : null;

  bool _isPunct(String value) {
    final t = _peek();
    return t != null && t.kind == _TokenKind.punct && t.value == value;
  }

  bool _eatPunct(String value) {
    if (_isPunct(value)) {
      _i++;
      return true;
    }
    return false;
  }

  void _expectPunct(String value) {
    if (!_eatPunct(value)) {
      final t = _peek();
      throw ExpressionSyntaxError('缺少 "$value"', t?.pos ?? -1);
    }
  }

  /// 过滤管道绑定最松：expr | name:arg1:arg2
  ExpressionNode _parseFilters() {
    var node = _parseTernary();
    while (_eatPunct('|')) {
      final nameTok = _peek();
      if (nameTok == null || nameTok.kind != _TokenKind.ident) {
        throw ExpressionSyntaxError('过滤器名必须是标识符', nameTok?.pos ?? -1);
      }
      _i++;
      final name = nameTok.value as String;
      if (!_filters.contains(name)) {
        throw ExpressionSyntaxError('未知过滤器：$name', nameTok.pos);
      }
      final args = <ExpressionNode>[];
      while (_eatPunct(':')) {
        final arg = _peek();
        //  示例 {{ amount | currency:CNY }}：裸标识符参数按字符串字面量处理
        // 
        if (arg == null ||
            (arg.kind != _TokenKind.str &&
                arg.kind != _TokenKind.num &&
                arg.kind != _TokenKind.ident)) {
          throw ExpressionSyntaxError('过滤器参数必须是字符串/数字/裸标识符字面量', arg?.pos ?? -1);
        }
        _i++;
        args.add(LiteralNode(arg.value));
      }
      final rule = _filterArgRules[name] ?? const [];
      if (args.length > rule.length) {
        throw ExpressionSyntaxError('过滤器 $name 最多接受 ${rule.length} 个参数', nameTok.pos);
      }
      for (var idx = 0; idx < args.length; idx++) {
        final expect = rule[idx].replaceAll(RegExp(r'\?$'), '');
        if (expect == 'any') continue;
        final value = (args[idx] as LiteralNode).value;
        if (expect == 'string' && value is! String) {
          throw ExpressionSyntaxError('过滤器 $name 第 ${idx + 1} 个参数必须是字符串', nameTok.pos);
        }
        if (expect == 'number' && value is! double) {
          throw ExpressionSyntaxError('过滤器 $name 第 ${idx + 1} 个参数必须是数字', nameTok.pos);
        }
      }
      if (name == 'date' && args.isNotEmpty) {
        _checkDateFormat((args[0] as LiteralNode).value! as String, nameTok.pos);
      }
      node = FilterNode(node, name, args);
    }
    return node;
  }

  ExpressionNode _parseTernary() {
    final test = _parseBinary(0);
    if (_eatPunct('?')) {
      final consequent = _parseTernary();
      _expectPunct(':');
      final alternate = _parseTernary();
      return TernaryNode(test, consequent, alternate);
    }
    return test;
  }

  static const List<List<String>> _precedence = [
    ['||'],
    ['&&'],
    ['==', '!=', '===', '!=='],
    ['<', '<=', '>', '>='],
    ['+', '-'],
    ['*', '/', '%'],
  ];

  ExpressionNode _parseBinary(int level) {
    if (level >= _precedence.length) return _parseUnary();
    var left = _parseBinary(level + 1);
    final ops = _precedence[level];
    for (;;) {
      final t = _peek();
      if (t != null && t.kind == _TokenKind.punct && ops.contains(t.value)) {
        _i++;
        final right = _parseBinary(level + 1);
        left = BinaryNode(t.value as String, left, right);
        continue;
      }
      return left;
    }
  }

  ExpressionNode _parseUnary() {
    final t = _peek();
    if (t != null &&
        t.kind == _TokenKind.punct &&
        (t.value == '-' || t.value == '+' || t.value == '!')) {
      _i++;
      return UnaryNode(t.value as String, _parseUnary());
    }
    return _parsePostfix();
  }

  ExpressionNode _parsePostfix() {
    var node = _parsePrimary();
    for (;;) {
      if (_eatPunct('.')) {
        final t = _peek();
        if (t == null || t.kind != _TokenKind.ident) {
          throw ExpressionSyntaxError('"." 后必须是标识符', t?.pos ?? -1);
        }
        _i++;
        node = _appendSegment(node, t.value as String);
        continue;
      }
      if (_eatPunct('[')) {
        final t = _peek();
        if (t == null ||
            t.kind != _TokenKind.num ||
            !_isIntegerValue(t.value as double)) {
          throw ExpressionSyntaxError(
              '索引仅支持非负整数（通配符 [*] 不参与表达式文法）', t?.pos ?? -1);
        }
        _i++;
        _expectPunct(']');
        node = _appendSegment(node, (t.value as double).toInt());
        continue;
      }
      return node;
    }
  }

  /// path 追加段；非 path 节点（如函数返回值）不允许继续取成员。
  static ExpressionNode _appendSegment(ExpressionNode node, Object seg) {
    if (node is! PathNode) {
      throw const ExpressionSyntaxError('仅字段路径支持成员/索引访问', -1);
    }
    return PathNode([...node.segments, seg]);
  }

  ExpressionNode _parsePrimary() {
    final t = _peek();
    if (t == null) throw const ExpressionSyntaxError('表达式意外结束', -1);
    if (t.kind == _TokenKind.num || t.kind == _TokenKind.str) {
      _i++;
      return LiteralNode(t.value);
    }
    if (t.kind == _TokenKind.punct && t.value == '(') {
      _i++;
      final node = _parseFilters();
      _expectPunct(')');
      return node;
    }
    if (t.kind == _TokenKind.ident) {
      _i++;
      final name = t.value as String;
      if (name == 'true' || name == 'false') return LiteralNode(name == 'true');
      if (name == 'null') return const LiteralNode(null);
      if (_isPunct('(')) {
        _i++;
        final args = <ExpressionNode>[];
        if (!_isPunct(')')) {
          for (;;) {
            args.add(_parseTernary());
            if (_eatPunct(',')) continue;
            break;
          }
        }
        _expectPunct(')');
        return CallNode(name, args);
      }
      return PathNode([name]);
    }
    throw ExpressionSyntaxError('意外的记号', t.pos);
  }

  static bool _isIntegerValue(double v) =>
      !v.isNaN && !v.isInfinite && v == v.truncateToDouble();
}

void _checkDepth(ExpressionNode node, int depth) {
  if (depth > maxAstDepth) {
    throw const ExpressionSyntaxError('表达式嵌套过深', -1);
  }
  switch (node) {
    case UnaryNode(:final operand):
      _checkDepth(operand, depth + 1);
    case BinaryNode(:final left, :final right):
      _checkDepth(left, depth + 1);
      _checkDepth(right, depth + 1);
    case TernaryNode(:final test, :final consequent, :final alternate):
      _checkDepth(test, depth + 1);
      _checkDepth(consequent, depth + 1);
      _checkDepth(alternate, depth + 1);
    case FilterNode(:final value):
      _checkDepth(value, depth + 1);
    case CallNode(:final args):
      for (final a in args) {
        _checkDepth(a, depth + 1);
      }
    case LiteralNode():
    case PathNode():
      break;
  }
}

// ---------- 求值 ----------

class _EvalCtx {
  final Map<String, Object?> data;
  final int deadlineMs;
  int ticks = 0;

  _EvalCtx(this.data, this.deadlineMs);
}

int _nowMs() => DateTime.now().millisecondsSinceEpoch;

void _tick(_EvalCtx ctx) {
  ctx.ticks++;
  if (ctx.ticks % 128 == 0 && _nowMs() > ctx.deadlineMs) {
    throw TimeoutException('表达式求值超时（沙箱限额）');
  }
}

/// 表达式求值超时（沙箱限额；对应 C# TimeoutException）。
class TimeoutException implements Exception {
  final String message;
  const TimeoutException(this.message);
  @override
  String toString() => 'TimeoutException: $message';
}

double? _tryGetDouble(Object? v) {
  if (v is double) return v;
  if (v is int) return v.toDouble();
  return null;
}

/// JS truthy 判定。
bool _isTruthy(Object? v) {
  if (v == null || v is JsUndefined) return false;
  if (v is bool) return v;
  if (v is String) return v.isNotEmpty;
  final d = _tryGetDouble(v);
  return d == null || (d != 0 && !d.isNaN);
}

/// 原型链防护（二轮）：仅读自有键——Map/List 天然仅自有成员，
/// constructor/__proto__ 等 JS 继承成员在 Dart 侧不可达（多语言实现同口径）。
/// 自有访问复刻 JS Object.hasOwn(cur, seg)：字典数字段按键串 "0" 命中；
/// 列表的 length 为自有属性；非整数字符串段对列表不可达。
Object? _resolvePath(List<Object> segments, Map<String, Object?> data) {
  Object? cur = data;
  for (final seg in segments) {
    if (cur == null || cur is JsUndefined) return JsUndefined.value;
    if (cur is Map) {
      final key = seg is int ? '$seg' : seg as String;
      if (!cur.containsKey(key)) return JsUndefined.value;
      cur = cur[key];
      continue;
    }
    if (cur is List) {
      if (seg is String) {
        if (seg == 'length') {
          cur = cur.length.toDouble();
          continue;
        }
        final si = int.tryParse(seg);
        if (si == null || si < 0 || si >= cur.length) return JsUndefined.value;
        cur = _normalizeHostValue(cur[si]);
        continue;
      }
      if (seg is int && seg >= 0 && seg < cur.length) {
        cur = _normalizeHostValue(cur[seg]);
        continue;
      }
      return JsUndefined.value;
    }
    return JsUndefined.value;
  }
  return cur;
}

/// 宿主列表（List<int> 等）元素归一——与数字归一口径一致。
Object? _normalizeHostValue(Object? v) => _tryGetDouble(v) ?? v;

/// JS Number(string) 语义：trim 后空串 = 0；不支持十六进制（SPEC  分叉①）。
double _numberFromString(String s) {
  final t = s.trim();
  if (t.isEmpty) return 0;
  if (t == 'Infinity' || t == '+Infinity') return double.infinity;
  if (t == '-Infinity') return double.negativeInfinity;
  return double.tryParse(t) ?? double.nan;
}

/// TS toNumber 复刻：注意 '' → NaN（trim 守卫），与 numberFromString('') = 0 的
/// JS Number 口径分离——两处在 TS 源码中即为不同实现，Dart 保持一致。
double _toNumber(Object? v) {
  final d = _tryGetDouble(v);
  if (d != null) return d;
  if (v is String) {
    if (v.trim().isNotEmpty) {
      final n = _numberFromString(v);
      if (!n.isNaN) return n;
    }
  }
  if (v is bool) return v ? 1 : 0;
  if (v == null) return 0;
  return double.nan;
}

/// JS 严格相等（===）：类型+值；NaN !== NaN；+0 === -0；undefined 仅与自身相等；对象按引用。
bool _strictEquals(Object? a, Object? b) {
  if (a is JsUndefined && b is JsUndefined) return true;
  if (a is JsUndefined || b is JsUndefined) return false;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  final da = _tryGetDouble(a);
  final db = _tryGetDouble(b);
  if (da != null && db != null) return da == db;
  if (da != null || db != null) return false;
  if (a is String && b is String) return a == b;
  if (a is bool && b is bool) return a == b;
  if (a is String || a is bool || b is String || b is bool) return false;
  return identical(a, b);
}

/// 宽松相等（== 语义，：boolean 先转数字；number×string 走 JS Number）。
/// 口径为 TS-loose（忠实复刻 TS 源）：null/undefined 不互转、对象不做 ToPrimitive——
/// 与真实 JS == 有意分叉，多语言实现一致（SPEC  分叉③）。消费方不得以 x == null 判缺失。
bool _looseEquals(Object? a, Object? b) {
  if (a is bool) return _looseEquals(a ? 1.0 : 0.0, b);
  if (b is bool) return _looseEquals(a, b ? 1.0 : 0.0);
  if (_strictEquals(a, b)) return true;
  final da = _tryGetDouble(a);
  if (da != null && b is String) return da == _numberFromString(b);
  final db = _tryGetDouble(b);
  if (db != null && a is String) return db == _numberFromString(a);
  return false;
}

/// JS 抽象关系比较：双字符串 UTF-16 code unit 字典序；否则双侧 toNumber（NaN 一律 false）。
bool _relational(Object? l, Object? r, String op) {
  int cmp;
  if (l is String && r is String) {
    cmp = l.compareTo(r);
  } else {
    final a = _toNumber(l);
    final b = _toNumber(r);
    if (a.isNaN || b.isNaN) return false;
    cmp = a.compareTo(b);
  }
  switch (op) {
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
    case '>':
      return cmp > 0;
    default:
      return cmp >= 0;
  }
}

/// JS String(v)（拼接语义）：数字经 formatEcmaNumber；数组逗号连接；对象 [object Object]。
String _jsString(Object? v) {
  if (v == null) return 'null';
  if (v is JsUndefined) return 'undefined';
  if (v is String) return v;
  if (v is bool) return v ? 'true' : 'false';
  if (v is List) {
    return v
        .map((item) => item == null || item is JsUndefined ? '' : _jsString(item))
        .join(',');
  }
  if (v is Function) {
    // Dart 无运行期函数名反射；按 C# "function <name>() { [native code] }" 形态，
    // 名称以 anonymous 占位（登记分叉，拼接场景极少触达）。
    return 'function anonymous() { [native code] }';
  }
  final d = _tryGetDouble(v);
  if (d != null) {
    if (d.isNaN) return 'NaN';
    if (d == double.infinity) return 'Infinity';
    if (d == double.negativeInfinity) return '-Infinity';
    return formatEcmaNumber(d);
  }
  return '[object Object]';
}

Object? _evalNode(ExpressionNode node, _EvalCtx ctx) {
  _tick(ctx);
  switch (node) {
    case LiteralNode(:final value):
      return value;
    case PathNode(:final segments):
      return _resolvePath(segments, ctx.data);
    case UnaryNode(:final op, :final operand):
      final v = _evalNode(operand, ctx);
      if (op == '!') return !_isTruthy(v);
      return op == '-' ? -_toNumber(v) : _toNumber(v);
    case BinaryNode():
      return _evalBinary(node, ctx);
    case TernaryNode(:final test, :final consequent, :final alternate):
      return _evalNode(_isTruthy(_evalNode(test, ctx)) ? consequent : alternate, ctx);
    case FilterNode():
      return _applyFilter(node, ctx);
    case CallNode(:final name, :final args):
      // 原型链防护（同 resolvePath）：仅自有键注入的函数可调用
      final fn = ctx.data.containsKey(name) ? ctx.data[name] : null;
      if (fn is! Function) {
        throw StateError('未注册函数：$name（自定义函数须由宿主注入求值上下文）');
      }
      final evaluated = args.map((a) => _evalNode(a, ctx)).toList();
      return Function.apply(fn, evaluated);
  }
}

Object? _evalBinary(BinaryNode node, _EvalCtx ctx) {
  if (node.op == '&&') {
    final l = _evalNode(node.left, ctx);
    return _isTruthy(l) ? _evalNode(node.right, ctx) : l;
  }
  if (node.op == '||') {
    final l = _evalNode(node.left, ctx);
    return _isTruthy(l) ? l : _evalNode(node.right, ctx);
  }
  final lv = _evalNode(node.left, ctx);
  final rv = _evalNode(node.right, ctx);
  switch (node.op) {
    case '===':
      return _strictEquals(lv, rv);
    case '!==':
      return !_strictEquals(lv, rv);
    case '==':
      return _looseEquals(lv, rv);
    case '!=':
      return !_looseEquals(lv, rv);
    case '<':
    case '<=':
    case '>':
    case '>=':
      return _relational(lv, rv, node.op);
    case '+':
      if (lv is String || rv is String) {
        // TS：`${l ?? ''}${r ?? ''}` —— null/undefined → 空串（SPEC  分叉④）
        return (lv == null || lv is JsUndefined ? '' : _jsString(lv)) +
            (rv == null || rv is JsUndefined ? '' : _jsString(rv));
      }
      return _toNumber(lv) + _toNumber(rv);
    case '-':
      return _toNumber(lv) - _toNumber(rv);
    case '*':
      return _toNumber(lv) * _toNumber(rv);
    case '/':
      return _toNumber(lv) / _toNumber(rv);
    case '%':
      return _jsRemainder(_toNumber(lv), _toNumber(rv));
    default:
      throw StateError('未知操作符：${node.op}');
  }
}

/// JS 余数（%）：符号随被除数——Dart 内建 % 为欧氏模（结果非负），手动复刻。
double _jsRemainder(double a, double b) {
  if (a.isNaN || b.isNaN || a.isInfinite || b == 0) return double.nan;
  if (b.isInfinite) return a;
  return a - (a / b).truncateToDouble() * b;
}

// ---------- 过滤器（主文档  七例 + default/avg/min/max） ----------

const Map<String, String> _currencySymbol = {
  'CNY': '¥',
  'USD': r'$',
  'EUR': '€',
  'GBP': '£',
  'JPY': 'JP¥',
  'HKD': r'HK$',
  'KRW': '₩',
  'TWD': r'NT$',
};

int _doubleToInt64Bits(double d) =>
    (ByteData(8)..setFloat64(0, d)).getInt64(0);

/// JS Number.prototype.toFixed 复刻：ties 远离零（(−0.5).toFixed(0)="-1"，Node 实测基线）；
/// |x| ≥ 1e21 回退 formatEcmaNumber（JS 同行为）。实现为精确有理数算术
/// （IEEE-754 分解 x = m×2^e2，与 10^f 通分后整除），避免任何浮点精度回归。
String toFixed(double x, int f) {
  if (x.isNaN) return 'NaN';
  if (x == double.infinity) return 'Infinity';
  if (x == double.negativeInfinity) return '-Infinity';
  if (x.abs() >= 1e21) return formatEcmaNumber(x);
  final negative = x < 0;
  final bits = _doubleToInt64Bits(x.abs());
  var mantissa = BigInt.from(bits & 0xFFFFFFFFFFFFF);
  var exp = (bits >> 52) & 0x7FF;
  if (exp == 0) {
    exp = -1074; // 次正规数：value = mantissa × 2^-1074
  } else {
    mantissa += BigInt.one << 52;
    exp -= 1075;
  }
  final e10 = BigInt.from(10).pow(f);
  BigInt numerator, denominator;
  if (exp >= 0) {
    numerator = mantissa * (BigInt.one << exp) * e10;
    denominator = BigInt.one;
  } else {
    numerator = mantissa * e10;
    denominator = BigInt.one << (-exp);
  }
  final rounded = (numerator * BigInt.two + denominator) ~/ (denominator * BigInt.two);
  var digits = rounded.toString();
  if (f == 0) return '${negative ? '-' : ''}$digits';
  if (digits.length <= f) digits = digits.padLeft(f + 1, '0');
  final intPart = digits.substring(0, digits.length - f);
  final frac = digits.substring(digits.length - f);
  return '${negative ? '-' : ''}$intPart.$frac';
}

/// JS Math.round 复刻：floor(x + 0.5)；jsRound(-0.5) = -0（禁银行家舍入）。
double jsRound(double x) {
  if (x.isNaN) return double.nan;
  if (x.isInfinite) return x;
  final f = (x + 0.5).floorToDouble();
  if (f == 0 && x < 0) return -0.0;
  return f;
}

final RegExp _groupRe = RegExp(r'\B(?=(\d{3})+(?!\d))');

String _formatNumber(double v, int digits) {
  final fixedStr = toFixed(v, digits);
  final parts = fixedStr.split('.');
  final intPart = parts[0];
  final frac = parts.length > 1 ? parts[1] : null;
  final negative = intPart.startsWith('-');
  final digitsOnly = negative ? intPart.substring(1) : intPart;
  final grouped = digitsOnly.replaceAllMapped(_groupRe, (_) => ',');
  return '${negative ? '-' : ''}$grouped${frac != null ? '.$frac' : ''}';
}

/// JS new Date(v) 语义：数字 = unix ms；
/// 字符串接受 V8 ISO 8601 子集（见 parseJsIso）。V8 遗留格式（MM/DD/YYYY、月名、
/// 裸时间等）不支持 → null → ''（SPEC  分叉②）。数值分支与 TS toDate 逐字一致：
/// NaN/Infinity/超 ±8.64e15 范围 → JsDate.invalid（FormatDate 输出 "NaN" 占位；
/// 不得返 null→''——'' 仅字符串解析失败）。
JsDate? _toDate(Object? v) {
  final ms = _tryGetDouble(v);
  if (ms != null) {
    if (ms.isNaN || ms.isInfinite) return JsDate.invalid;
    // V8 合法 ms 范围 ±8.64e15（Node 实测：8640000000000000 合法、+1 Invalid）
    if (ms > 8.64e15 || ms < -8.64e15) return JsDate.invalid;
    return JsDate(ms.toInt());
  }
  return v is String ? parseJsIso(v) : null;
}

/// V8 ISO 8601 子集：
///  - 月/日允许非补零（"2026-1-1" 合法）
///  - hour=24 且分秒毫秒全 0 进位到次日零点（"2026-01-01T24:00" → 次日）
///  - 时区偏移放宽至 ±23:59（V8 实测 +23:59/-23:59 合法）
///  - 首尾空白：date-only / 空格分隔形态宽容（V8 真值），T 分隔形态严格拒绝
///  - year=0 支持 proleptic Gregorian
///  - day>当月天数自动进位（withAddedDays，V8 同语义）
/// offset 语义：date-only → 按 UTC（offset=0）；date+time 无时区 → 本地；
/// Z → UTC；±HH:mm → 该偏移。JsDate 仅存 UtcMs，字段访问走系统本地时区（V8 语义）。
JsDate? parseJsIso(String raw) {
  // V8 真值：含 T/t 分隔符的 ISO 严格（首尾空白拒绝）；date-only / 空格分隔形态宽容
  var s = raw;
  if (!raw.contains('T') && !raw.contains('t')) {
    s = raw.trim();
  }
  final m = _isoDateRe.firstMatch(s);
  if (m == null) return null;
  final year = int.parse(m.group(1)!);
  final month = m.group(2) != null ? int.parse(m.group(2)!) : 1;
  var day = m.group(3) != null ? int.parse(m.group(3)!) : 1;
  if (month < 1 || month > 12 || day < 1) return null;
  if (m.group(4) == null) {
    // date-only → 按 UTC 存储（offset=0）；day>当月天数时进位（V8 同语义）
    final base = JsDate.fromLocal(year, month, 1, 0, 0, 0, 0, 0);
    return base.withAddedDays(day - 1);
  }
  var hour = int.parse(m.group(4)!);
  final minute = int.parse(m.group(5)!);
  final second = m.group(6) != null ? int.parse(m.group(6)!) : 0;
  if (minute > 59 || second > 59) return null;
  var millis = 0;
  final frac = m.group(7);
  if (frac != null) {
    millis = int.parse('${frac}000'.substring(0, 3));
  }
  // hour=24 V8 真值：仅当分/秒/毫秒全 0 时进位到次日零点，否则拒绝
  if (hour == 24) {
    if (minute != 0 || second != 0 || millis != 0) return null;
    hour = 0;
    day = day + 1;
  } else if (hour > 24) {
    return null;
  }
  // 时区解析：date+time 无时区 → 本地 offset；Z → 0；±HH:mm → 该偏移
  final zone = m.group(8) ?? '';
  int offsetMinutes;
  if (zone.isEmpty) {
    offsetMinutes = localOffsetMinutes();
  } else if (zone == 'Z' || zone == 'z') {
    offsetMinutes = 0;
  } else {
    final sign = zone[0] == '-' ? -1 : 1;
    final zoneBody = zone.substring(1).replaceAll(':', '');
    final zh = int.parse(zoneBody.substring(0, 2));
    final zm = int.parse(zoneBody.substring(2, 4));
    // V8 真值：时区偏移上限 ±23:59（Node v22.22.2 实测，原 ±14:00 过严）
    if (zh > 23 || zm > 59) return null;
    offsetMinutes = sign * (zh * 60 + zm);
  }
  // 用 day=1 + withAddedDays(day-1) 处理 day>当月天数进位
  final base = JsDate.fromLocal(year, month, 1, hour, minute, second, millis, offsetMinutes);
  return base.withAddedDays(day - 1);
}

String _formatDate(JsDate d, String fmt) {
  // V8 Invalid Date（数值 ms 超范围）：getFullYear/getMonth 等全 NaN，
  // String(NaN)="NaN"、padStart 对 3 字符 "NaN" 不补 → 各占位符均输出 "NaN"
  if (!d.isValid) {
    return fmt
        .replaceAll('YYYY', 'NaN')
        .replaceAll('MM', 'NaN')
        .replaceAll('DD', 'NaN')
        .replaceAll('HH', 'NaN')
        .replaceAll('mm', 'NaN')
        .replaceAll('ss', 'NaN');
  }
  // V8 语义：getFullYear 等用「系统本地时区」，与输入自带 offset 无关
  final f = d.deconstructLocal(localOffsetMinutes());
  // YYYY 占位符按 V8 String(getFullYear()) 实际位数输出（year=0 → "0"，不补零）；
  // padStart 仅在 MM/DD/HH/mm/ss。
  return fmt
      .replaceAll('YYYY', '${f.year}')
      .replaceAll('MM', '${f.month}'.padLeft(2, '0'))
      .replaceAll('DD', '${f.day}'.padLeft(2, '0'))
      .replaceAll('HH', '${f.hour}'.padLeft(2, '0'))
      .replaceAll('mm', '${f.minute}'.padLeft(2, '0'))
      .replaceAll('ss', '${f.second}'.padLeft(2, '0'));
}

Object? _readField(Object? item, String field) {
  if (item is Map && item.containsKey(field)) return item[field];
  return JsUndefined.value;
}

Object? _applyFilter(FilterNode node, _EvalCtx ctx) {
  final v = _evalNode(node.value, ctx);
  final args = node.args.map((a) => _evalNode(a, ctx)).toList();
  switch (node.name) {
    case 'date':
      final d = _toDate(v);
      if (d == null) return '';
      return _formatDate(
          d, args.isNotEmpty && args[0] is String ? args[0] as String : 'YYYY-MM-DD');
    case 'currency':
      final n = _toNumber(v);
      if (n.isNaN) return '';
      if (args.isNotEmpty && args[0] is! String) {
        throw StateError('currency 过滤器参数必须是币种代码字符串（编译期已校，此为防御分支）');
      }
      final code = args.isNotEmpty ? args[0] as String : 'CNY';
      final symbol = _currencySymbol[code] ?? '$code ';
      return '$symbol${_formatNumber(n, 2)}';
    case 'round':
      final n = _toNumber(v);
      if (n.isNaN) return '';
      final arg = args.isNotEmpty ? _tryGetDouble(args[0]) : null;
      final digits = arg ?? 0;
      final factor = math.pow(10, digits).toDouble();
      return jsRound(n * factor) / factor;
    case 'sum':
      if (v is! List) return '';
      final field = args.isNotEmpty && args[0] is String ? args[0] as String : null;
      var acc = 0.0;
      for (final item in v) {
        final raw = field != null ? _readField(item, field) : item;
        final n = _toNumber(raw);
        acc += n.isNaN ? 0 : n;
      }
      return acc;
    case 'avg':
    case 'min':
    case 'max':
      if (v is! List) return '';
      final field = args.isNotEmpty && args[0] is String ? args[0] as String : null;
      final nums = <double>[];
      for (final item in v) {
        final raw = field != null ? _readField(item, field) : item;
        final n = _toNumber(raw);
        if (!n.isNaN) nums.add(n);
      }
      if (nums.isEmpty) return '';
      if (node.name == 'avg') {
        return nums.reduce((a, b) => a + b) / nums.length;
      }
      return node.name == 'min'
          ? nums.reduce((a, b) => a < b ? a : b)
          : nums.reduce((a, b) => a > b ? a : b);
    case 'count':
      if (v is List) return v.length.toDouble();
      if (v is String) return v.length.toDouble();
      return 0.0;
    case 'truncate':
      final s = v == null || v is JsUndefined ? '' : _jsString(v);
      final maxArg = args.isNotEmpty ? _tryGetDouble(args[0]) : null;
      final max = maxArg ?? 20;
      if (s.length <= max) return s; // 含 max=3e9（钳制返回全串）；NaN 不成立走下面
      // JS slice(0, max) 钳制语义：负数按长度相对取，NaN→0；
      // 此处 max < s.length，截断值必在 int 域内，无溢出
      final t = max.truncateToDouble();
      int end;
      if (t.isNaN) {
        end = 0;
      } else if (t >= 0) {
        end = t.toInt();
      } else {
        final rel = t < -s.length ? -s.length : t.toInt();
        end = s.length + rel;
        if (end < 0) end = 0;
      }
      return '${s.substring(0, end)}...';
    case 'mask':
      // pattern 定义掩码版式：'*' 位输出 '*'，其余位透传原文同位字符（不足取 pattern 字符）
      final s = v == null || v is JsUndefined ? '' : _jsString(v);
      final pattern =
          args.isNotEmpty && args[0] is String ? args[0] as String : '*' * s.length;
      final sb = StringBuffer();
      for (var i = 0; i < pattern.length; i++) {
        final c = pattern[i];
        sb.write(c == '*' ? '*' : (i < s.length ? s[i] : c));
      }
      return sb.toString();
    case 'default':
      final fallback = args.isNotEmpty ? args[0] : null;
      if (v == null || v is JsUndefined || (v is String && v.isEmpty)) {
        return fallback ?? '';
      }
      return v;
    default:
      throw StateError('未知过滤器：${node.name}');
  }
}

void _walkFields(ExpressionNode node, List<String> out, Set<String> seen) {
  switch (node) {
    case PathNode(:final segments):
      final joined = segments.join('.');
      if (seen.add(joined)) out.add(joined);
    case UnaryNode(:final operand):
      _walkFields(operand, out, seen);
    case BinaryNode(:final left, :final right):
      _walkFields(left, out, seen);
      _walkFields(right, out, seen);
    case TernaryNode(:final test, :final consequent, :final alternate):
      _walkFields(test, out, seen);
      _walkFields(consequent, out, seen);
      _walkFields(alternate, out, seen);
    case FilterNode(:final value):
      _walkFields(value, out, seen);
    case CallNode(:final args):
      for (final a in args) {
        _walkFields(a, out, seen);
      }
    case LiteralNode():
      break;
  }
}

/// 表达式编译器：compile（≤1KB、嵌套 ≤64、白名单文法）+ evaluate（白名单操作符/
/// 过滤器、超时即抛）+ extractFields（字段联动校验）。自定义函数由宿主以
/// Dart Function 值注入 data（等价 C# Delegate 注入）。
class ExpressionCompiler {
  ExpressionCompiler._();

  /// 表达式 → AST（沙箱限额：UTF-8 ≤1KB、嵌套 ≤64；非法文法抛 ExpressionSyntaxError）。
  static ExpressionAst compile(String expr) {
    if (utf8Length(expr) > maxExprBytes) {
      throw const ExpressionSyntaxError('表达式超出沙箱限额（1KB）', -1);
    }
    final root = _ParserState(_tokenize(expr)).parse();
    _checkDepth(root, 1);
    return ExpressionAst(expr, root);
  }

  /// AST → 求值（沙箱：白名单操作符/过滤器、超时即抛 TimeoutException）。
  /// 自定义函数（ now()/uuid()/tenantName() 等）由宿主以 Function 值注入 data。
  static Object? evaluate(ExpressionAst ast, Map<String, Object?> data, double timeoutMs) {
    if (timeoutMs.isNaN || timeoutMs.isInfinite || timeoutMs <= 0) {
      throw ArgumentError.value(timeoutMs, 'timeoutMs', 'timeout 必须为正数（毫秒）');
    }
    final ctx = _EvalCtx(data, _nowMs() + timeoutMs.toInt());
    return _evalNode(ast.root, ctx);
  }

  /// 列出表达式引用的字段路径（数字索引以点段表示；去重保序）。
  static List<String> extractFields(ExpressionAst ast) {
    final out = <String>[];
    final seen = <String>{};
    _walkFields(ast.root, out, seen);
    return out;
  }
}

/// UTF-8 字节长度（沙箱 1KB 限额口径，与 TS TextEncoder/C# UTF8.GetByteCount 一致）。
int utf8Length(String s) {
  var count = 0;
  for (var i = 0; i < s.length; i++) {
    final cu = s.codeUnitAt(i);
    if (cu < 0x80) {
      count += 1;
    } else if (cu < 0x800) {
      count += 2;
    } else if (cu >= 0xD800 && cu <= 0xDBFF) {
      // 高代理 + 后续低代理 = 4 字节码点
      count += 4;
      i++;
    } else {
      count += 3;
    }
  }
  return count;
}
