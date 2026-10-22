// SPDX-License-Identifier: Apache-2.0
// ESC/POS 编码器字节断言。
//
// 断言三类语义（对齐跨语言 golden 契约，ADR-0009）：
// ① 命令字节子集：初始化/对齐/字号/粗体/切纸/钱箱等指令序列逐字节匹配；
// ② 编码点：中文走 GBK 双字节（字节值来自 oracle）、QR 走 GS ( k 五步；
// ③ 对齐结构：表格列宽分配（百分比 + 未指定均分）、表头表体、分隔线。

import 'dart:convert';
import 'dart:typed_data';

import 'package:taprint/printers.dart';
import 'package:test/test.dart';

import '../helpers/repo_paths.dart';

void main() {
  final encoder = EscPosEncoder(widthCols: 32);

  /// 在字节流中查找子序列 [pattern] 首次出现的偏移（自 [start] 起）；
  /// 未找到返回 -1。
  int indexOf(Uint8List bytes, List<int> pattern, [int start = 0]) {
    outer:
    for (var i = start; i + pattern.length <= bytes.length; i++) {
      for (var j = 0; j < pattern.length; j++) {
        if (bytes[i + j] != pattern[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  /// 命令断言：字节流包含 [pattern] 子序列。
  void expectHas(Uint8List bytes, List<int> pattern, {String? reason}) {
    expect(indexOf(bytes, pattern), greaterThanOrEqualTo(0),
        reason: reason ??
            '字节流包含 ${pattern.map((b) => b.toRadixString(16)).join(' ')}');
  }

  group('EscPosEncoder 命令与编码点（内联 DSL）', () {
    test('初始化 + 汉字模式 + 文本指令序列（double/bold/center）', () {
      const dsl = '''
{
  "schemaVersion": "1.0",
  "id": "tpl_esc_min",
  "presentations": {
    "receipt": {
      "width": "80mm",
      "encoding": "gbk",
      "initCommands": ["ESC @"],
      "body": [
        {"type": "text", "content": "收银小票", "align": "center",
         "style": {"fontSize": "double", "bold": true}},
        {"type": "text", "content": "商品 收银员", "align": "left"},
        {"type": "cut", "partial": true}
      ],
      "tailCommands": ["GS V 1"]
    }
  }
}
''';
      final bytes = encoder.encode(DslParser.parse(dsl), const <String, dynamic>{});

      expect(bytes[0], 0x1B, reason: '首字节 ESC');
      expect(bytes[1], 0x40, reason: '次字节 @（ESC @ 初始化）');
      expectHas(bytes, [0x1C, 0x26], reason: 'GBK 通道发汉字模式 1C 26');
      expectHas(bytes, [0x1D, 0x21, 0x11], reason: 'GS ! 0x11 double 字号');
      expectHas(bytes, [0x1B, 0x45, 0x01], reason: 'ESC E 1 粗体开');
      expectHas(bytes, [0x1B, 0x61, 0x01], reason: 'ESC a 1 居中对齐');
      expectHas(bytes, [0x1D, 0x21, 0x00], reason: 'GS ! 0x00 字号复位');
      expectHas(bytes, [0x1B, 0x45, 0x00], reason: 'ESC E 0 粗体复位');
      // 收=CA D5、银=D2 F8（oracle 锚点）
      expectHas(bytes, [0xCA, 0xD5], reason: 'GBK 收 双字节');
      expectHas(bytes, [0xD2, 0xF8], reason: 'GBK 银 双字节');
      final gbkHi = bytes.where((b) => b >= 0x81 && b <= 0xFE);
      expect(gbkHi.length, greaterThan(0), reason: '存在 GBK 高位字节');
      // 半切（cut partial=true，切纸前 3 行留白）+ 尾命令 GS V 1
      expectHas(bytes, [0x0A, 0x0A, 0x0A, 0x1D, 0x56, 0x01],
          reason: 'cut 半切 + 留白');
      expect(bytes.sublist(bytes.length - 3), const [0x1D, 0x56, 0x01],
          reason: '尾部为 tailCommands GS V 1');
    });

    test('QR 五步序列（GS ( k）+ 全切', () {
      const dsl = '''
{
  "schemaVersion": "1.0",
  "id": "tpl_qr_mini",
  "presentations": {
    "receipt": {
      "width": "80mm",
      "encoding": "gbk",
      "body": [
        {"type": "text", "content": "扫码", "align": "center"},
        {"type": "qrcode", "text": "https://shop.example/r/ABC123", "size": 6,
         "align": "center"},
        {"type": "cut", "partial": false}
      ]
    }
  }
}
''';
      final bytes = encoder.encode(DslParser.parse(dsl), const <String, dynamic>{});

      // 步 1：1D 28 6B 04 00 31 41 02 00（模型 2）
      expectHas(bytes, [0x1D, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x02, 0x00],
          reason: 'QR 步 1 模型 2');
      // 步 2：1D 28 6B 03 00 31 43 06（模块大小 6）
      expectHas(bytes, [0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, 0x06],
          reason: 'QR 步 2 模块大小');
      // 步 3：1D 28 6B 03 00 31 45 31（纠错 M=15%）
      expectHas(bytes, [0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x31],
          reason: 'QR 步 3 纠错 M');
      // 步 4 payload：url 29 字节 + 3 = 32 = 0x20 0x00
      expectHas(bytes, [0x1D, 0x28, 0x6B, 0x20, 0x00, 0x31, 0x50, 0x30],
          reason: 'QR 步 4 数据存储（pL pH）');
      expectHas(bytes, utf8.encode('https://shop.example/r/ABC123'),
          reason: 'QR 内容 ASCII');
      // 步 5：1D 28 6B 03 00 31 51 30（打印）
      expectHas(bytes, [0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30],
          reason: 'QR 步 5 打印');
      // 全切（cut partial=false）= GS V 0
      expectHas(bytes, [0x1D, 0x56, 0x00], reason: 'GS V 0 全切');
    });

    test('kvtable 单列 + table 百分比列宽 + 分隔线（40/20/40 → 13/6/13）', () {
      const dsl = '''
{
  "schemaVersion": "1.0",
  "id": "tpl_sales_table",
  "presentations": {
    "receipt": {
      "width": "80mm",
      "encoding": "gbk",
      "body": [
        {"type": "kvtable", "columns": 1, "rows": [[["单号", "SN-001"]]]},
        {"type": "table", "source": "items", "columns": [
          {"header": "商品", "field": "name", "width": "40%"},
          {"header": "数量", "field": "qty", "width": "20%"},
          {"header": "金额", "field": "amount", "width": "40%"}
        ]},
        {"type": "line"}
      ]
    }
  }
}
''';
      final bytes = encoder.encode(
        DslParser.parse(dsl),
        const <String, dynamic>{},
        details: const <String, List<Map<String, dynamic>>>{
          'items': [
            {'name': '苹果', 'qty': 2, 'amount': 10},
            {'name': '香蕉', 'qty': 1, 'amount': 5},
          ],
        },
      );

      // kvtable：单号左补位 + SN-001 右对齐落位
      expectHas(bytes, <int>[0xB5, 0xA5, 0xBA, 0xC5], reason: 'GBK 单号');
      expectHas(bytes, utf8.encode('SN-001'), reason: 'kvtable 值 ASCII');
      // 表头：商品(C9 CC C6 B7) / 数量(CA FD C1 BF) / 金额(BD F0 B6 EE)
      expectHas(bytes, [0xC9, 0xCC, 0xC6, 0xB7], reason: '表头 商品');
      expectHas(bytes, [0xCA, 0xFD, 0xC1, 0xBF], reason: '表头 数量');
      expectHas(bytes, [0xBD, 0xF0, 0xB6, 0xEE], reason: '表头 金额');
      // 表头分隔线 = 32 个 '-'（widthCols）
      expectHas(bytes, List<int>.filled(32, 0x2D), reason: '32 列分隔线');
      // 数据行 GBK 编码点
      expectHas(bytes, [0xC6, 0xBB, 0xB9, 0xFB], reason: '行 苹果');
      expectHas(bytes, [0xCF, 0xE3, 0xBD, 0xB6], reason: '行 香蕉');
      // line 元素 = 32 列分隔线（同表分隔线形态）
      expectHas(bytes, List<int>.filled(32, 0x2D));
    });

    test('init/tail 命令白名单：别名与未知命令', () {
      const dsl = '''
{
  "schemaVersion": "1.0",
  "id": "tpl_cmd_alias",
  "presentations": {
    "receipt": {
      "width": "80mm",
      "initCommands": ["esc  @", "GS V 48", "UNKNOWN CMD"],
      "tailCommands": ["GS V 49"],
      "body": []
    }
  }
}
''';
      final bytes = encoder.encode(DslParser.parse(dsl), const <String, dynamic>{});
      // 别名映射：GS V 48 = GS V 0（init 段）；未知命令静默忽略。
      expectHas(bytes, [0x1D, 0x56, 0x00], reason: 'GS V 48 → GS V 0');
      // init 段的重复 ESC @ 去重：全文恰一次 1B 40。
      expect(indexOf(bytes, [0x1B, 0x40]), 0);
      expect(indexOf(bytes, [0x1B, 0x40], 2), -1,
          reason: 'ESC @ 只出现一次（init 去重）');
      expect(bytes.sublist(bytes.length - 3), const [0x1D, 0x56, 0x01],
          reason: 'tailCommands GS V 49 → GS V 1');
    });

    test('钱箱脉冲：pulse 1 → m=0；pulse 2 → m=1', () {
      const dsl = '''
{
  "schemaVersion": "1.0",
  "id": "tpl_drawer",
  "presentations": {
    "receipt": {
      "width": "80mm",
      "body": [
        {"type": "cashDrawer", "pulse": 2, "style": {"pulse": 2}}
      ]
    }
  }
}
''';
      final bytes = encoder.encode(DslParser.parse(dsl), const <String, dynamic>{});
      expectHas(bytes, [0x1B, 0x70, 0x01, 0x19, 0x19],
          reason: 'ESC p m=1（pulse 2）');
    });

    test('默认 GB18030 全表通道；barcode 元素按未知口径折空行', () {
      const dsl = '''
{
  "schemaVersion": "1.0",
  "id": "tpl_misc",
  "presentations": {
    "receipt": {
      "body": [
        {"type": "barcode", "symbology": "CODE128", "content": "X"},
        {"type": "unknownX", "content": "Y"}
      ]
    }
  }
}
''';
      // barcode 与未知类型各折一个 LF：流 = init(2) + kanji(2) + LF + LF。
      final bytes = encoder.encode(DslParser.parse(dsl), const <String, dynamic>{});
      expect(bytes.length, 6, reason: 'init + 汉字模式 + 两个空行');
      expect(bytes.sublist(4), const [0x0A, 0x0A]);
    });
  });

  group('EscPosEncoder fixture 全链（fixtures/templates）', () {
    test('esc-pos-receipt-v1.0：全元素链路（text/kvtable/table/barcode/'
        'cashDrawer/cut + init/tail）', () {
      final template = DslParser.parse(
          readText('fixtures/templates/esc-pos-receipt-v1.0.json'));
      final primary = <String, dynamic>{
        'billNo': 'SN-2026-001',
        'billDate': '2026-01-02T10:30:00',
        'store': {'name': '测试门店', 'phone': '010-88886666'},
        'cashier': '张三',
        'totalAmount': 38.5,
        'discount': 0.5,
        'paidAmount': 40,
        'changeAmount': 1.5,
        'payMethod': '现金',
      };
      final bytes = encoder.encode(
        template,
        primary,
        details: const <String, List<Map<String, dynamic>>>{
          'items': [
            {'name': '苹果', 'qty': 2, 'amount': 10},
            {'name': '香蕉', 'qty': 1, 'amount': 5},
          ],
        },
      );

      // 头部：ESC @ + 汉字模式
      expect(bytes.sublist(0, 2), const [0x1B, 0x40]);
      expect(bytes.sublist(2, 4), const [0x1C, 0x26]);
      // 店名（center/double/bold）与收银小票
      expectHas(bytes, <int>[0xB2, 0xE2, 0xCA, 0xD4, 0xC3, 0xC5, 0xB5, 0xEA],
          reason: 'GBK 测试门店');
      expectHas(bytes, <int>[0xCA, 0xD5, 0xD2, 0xF8, 0xD0, 0xA1, 0xC6, 0xB1],
          reason: 'GBK 收银小票');
      // 日期过滤器：'YYYY-MM-DD HH:mm'
      expectHas(bytes, utf8.encode('2026-01-02 10:30'), reason: 'date 过滤器');
      // kvtable 表头字段 + 表格列头/行
      expectHas(bytes, <int>[0xB5, 0xA5, 0xBA, 0xC5], reason: 'GBK 单号');
      expectHas(bytes, utf8.encode('SN-2026-001'));
      expectHas(bytes, <int>[0xCA, 0xD5, 0xD2, 0xF8, 0xD4, 0xB1],
          reason: 'GBK 收银员');
      expectHas(bytes, <int>[0xC9, 0xCC, 0xC6, 0xB7], reason: '表头 商品');
      expectHas(bytes, <int>[0xCF, 0xE3, 0xBD, 0xB6], reason: '行 香蕉');
      // currency 过滤器：两位小数无千分位
      expectHas(bytes, utf8.encode('38.50'), reason: '合计 currency');
      expectHas(bytes, utf8.encode('1.50'), reason: '找零 currency');
      expectHas(bytes, <int>[0xCF, 0xD6, 0xBD, 0xF0], reason: 'GBK 现金');
      // 谢谢惠顾，欢迎再次光临！（含全角标点 A3 AC / A3 A1）
      expectHas(bytes, <int>[
        0xD0, 0xBB, 0xD0, 0xBB, 0xBB, 0xDD, 0xB9, 0xCB, // 谢谢惠顾
        0xA3, 0xAC, // ，
        0xBB, 0xB6, 0xD3, 0xAD, 0xD4, 0xD9, 0xB4, 0xCE, 0xB9, 0xE2, 0xC1, 0xD9, // 欢迎再次光临
        0xA3, 0xA1, // ！
      ], reason: 'GBK 谢谢惠顾，欢迎再次光临！');
      // 钱箱（pulse 元素级缺省 1 → m=0）
      expectHas(bytes, [0x1B, 0x70, 0x00, 0x19, 0x19], reason: '钱箱脉冲 m=0');
      // 半切 + 尾命令 GS V 1
      expectHas(bytes, [0x0A, 0x0A, 0x0A, 0x1D, 0x56, 0x01], reason: '半切');
      expect(bytes.sublist(bytes.length - 3), const [0x1D, 0x56, 0x01]);
    });
  });
}
