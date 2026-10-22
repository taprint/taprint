// SPDX-License-Identifier: Apache-2.0
// ECMA-262 Number::toString(10) 复刻——全内核唯一数字出口（canonical 写出、
// 表达式拼接/过滤器的数字→字符串均经此函数）。锁定物：fixture v4
//（0.1/1.0/1e2/2.5 → 0.1/1/100/2.5）与 EcmaNumber 黄金表（多语言实现同源）。
// Dart 内建格式器（toString/toStringAsFixed/jsonEncode）在指数文法、-0、阈值上
// 与 JS 不一致（如 jsonEncode(1.0) = "1.0"，SPEC  登记分叉），禁止绕过本函数。

const double _maxSafeInteger = 9007199254740992; // 2^53

String formatEcmaNumber(num value) {
  final v0 = value.toDouble();
  if (v0.isNaN || v0.isInfinite) {
    throw ArgumentError.value(value, 'value', '非 JSON-safe 数字（NaN/Infinity）');
  }
  if (v0 == 0) return '0'; // 含 -0（JS (-0).toString() === "0"）
  final negative = v0 < 0;
  final v = v0.abs();
  final prefix = negative ? '-' : '';

  // 整数捷径：≤ 2^53 的整数值精确可表示，最短数字串即全位数字
  //（> 2^53 的整数值须走一般路径按最短串补零，如 JS 12345678901234567890 → ...67000）
  if (v <= _maxSafeInteger && v == v.truncateToDouble()) {
    return '$prefix${v.toInt()}';
  }

  // 最短往返数字串：精度 p=1..17 递增取首个可往返者（等价 ECMA「最少数字位数」+
  // 等长取最接近值的取舍）。toStringAsPrecision 输出无尾随零（指数文法 "1.23e+20"）。
  var candidate = '';
  for (var p = 1; p <= 17; p++) {
    final c = v.toStringAsPrecision(p);
    if (double.parse(c) == v) {
      candidate = c;
      break;
    }
  }

  // 解析候选串（形如 "123" / "1.23" / "1.23e+20"）为 digits + n（ECMA 6.1.6.1.20：
  // value = Σ d_i × 10^(n-i)，n 为十进制小数点位置）。
  var exp = 0;
  var mantissa = candidate;
  final eIdx = candidate.indexOf('e');
  if (eIdx >= 0) {
    mantissa = candidate.substring(0, eIdx);
    exp = int.parse(candidate.substring(eIdx + 1));
  }
  final dot = mantissa.indexOf('.');
  final dotIndex = dot >= 0 ? dot : mantissa.length;
  final raw = mantissa.replaceAll('.', '');
  var lz = 0;
  while (lz < raw.length && raw.codeUnitAt(lz) == 0x30) {
    lz++;
  }
  final digits = raw.substring(lz);
  final n = dotIndex + exp - lz;
  final k = digits.length;

  String text;
  if (k <= n && n <= 21) {
    text = digits + '0' * (n - k);
  } else if (n > 0 && n <= 21) {
    text = '${digits.substring(0, n)}.${digits.substring(n)}';
  } else if (n > -6 && n <= 0) {
    text = '0.${'0' * (-n)}$digits';
  } else {
    final expText = 'e${n - 1 >= 0 ? '+' : '-'}${(n - 1).abs()}';
    text = k == 1 ? '$digits$expText' : '${digits[0]}.${digits.substring(1)}$expText';
  }
  return prefix + text;
}
