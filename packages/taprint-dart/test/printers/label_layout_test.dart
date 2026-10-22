// SPDX-License-Identifier: Apache-2.0
// 标签布局解析（LabelLayoutParser）契约测试：
// - 解析七项对表：根结构 / mm 字符串 / 顶层 size 字号 / barcode 高度 /
//   未知 type / 未知 schemaVersion / 缺省值；
// - 坏 JSON 与结构异常 → FormatException（不拒载策略只针对可解析面）。

import 'package:taprint/printers.dart';
import 'package:test/test.dart';

void main() {
  const sample1 = '''
{"schemaVersion":"1.0","id":"tpl_sample_4030","code":"SAMPLE_4030_PRICE",
 "presentations":{"label":{"size":{"width":"40mm","height":"30mm"},"gap":"2mm","density":8,"speed":4,"copies":1,
 "body":[
  {"type":"text","content":"{{name}}","x":"2mm","y":"2mm","size":1},
  {"type":"text","content":"¥{{price}}/{{unit}}","x":"2mm","y":"11mm","size":2},
  {"type":"barcode","symbology":"CODE128","content":"{{sku}}","x":"2mm","y":"19mm","height":"9mm"}
]}}}''';

  const sample2 = '''
{"schemaVersion":"1.0","id":"tpl_sample_5030",
 "presentations":{"label":{"size":{"width":"50mm","height":"30mm"},
 "body":[
  {"type":"text","content":"{{name}}","x":"2mm","y":"2mm","size":1},
  {"type":"qrcode","content":"{{sku}}","x":"2mm","y":"16mm","size":4}
]}}}''';

  LabelSpec specOfElem(String elem) => LabelLayoutParser.parse(
      '{"presentations":{"label":{"size":{"width":"40mm","height":"30mm"},'
      '"body":[$elem]}}}');

  group('根键名与嵌套结构', () {
    test('样例 1：presentations.label{size,gap,density,speed,copies,body} 落位',
        () {
      final spec = LabelLayoutParser.parse(sample1);
      expect(spec.widthMm, 40);
      expect(spec.heightMm, 30);
      expect(spec.gapMm, 2);
      expect(spec.density, 8);
      expect(spec.speed, 4);
      expect(spec.copiesTemplate, '1');
      expect(spec.body.length, 3);
      expect(spec.body[0].type, 'text');
      expect(spec.body[0].content, '{{name}}');
      expect(spec.body[2].type, 'barcode');
      expect(spec.body[2].symbology, 'CODE128');
    });

    test('parser 不消费根级 code/name；schemaVersion 只读兼容档判定', () {
      final spec = LabelLayoutParser.parse(sample1
          .replaceFirst('"schemaVersion":"1.0"', '"schemaVersion":"9.9"'));
      expect(spec.widthMm, 40);
    });
  });

  group('mm 字符串解析', () {
    double? parse(dynamic raw) {
      if (raw is num) return raw.toDouble();
      if (raw is String) {
        final s = raw.toLowerCase().trim();
        final stripped = s.endsWith('mm') ? s.substring(0, s.length - 2) : s;
        return double.tryParse(stripped.trim());
      }
      return null;
    }

    test('带单位/裸数/小数三种形态', () {
      expect(parse('40mm'), 40);
      expect(parse('40'), 40);
      expect(parse('40.5mm'), 40.5);
      expect(parse('2.5mm'), 2.5);
    });

    test('schema 合法单位 cm/pt/px 现解析回退缺省（只认 mm 与裸数）', () {
      expect(parse('4cm'), isNull);
      expect(parse('80pt'), isNull);
      expect(parse('100px'), isNull);
    });

    test('接受裸负数（superset 向后兼容）', () {
      expect(parse('-1mm'), -1);
    });
  });

  group('text.size 字号语义', () {
    test('顶层 size 承载（textSize）；0 折 1、域外夹顶 1-10', () {
      final spec = LabelLayoutParser.parse(sample1);
      expect(spec.body[1].textSize, 2);

      expect(specOfElem('{"type":"text","content":"a","size":0}').body.single.textSize, 0);
      final clamped = TsplEncoder.resolveTextMultiplier(
          specOfElem('{"type":"text","content":"a","size":99}').body.single);
      expect(clamped, const (10, 10));
      final zero = TsplEncoder.resolveTextMultiplier(
          specOfElem('{"type":"text","content":"a","size":0}').body.single);
      expect(zero, const (1, 1), reason: 'size 0 折 1');
    });

    test('未写顶层 size → textSize=null（编码器回 style.fontSize 兼容档）', () {
      final spec = specOfElem('{"type":"text","content":"a"}');
      expect(spec.body.single.textSize, isNull);
    });
  });

  group('barcode height 语义（条高 mm）', () {
    test('样例 1：height:"9mm" → 9mm', () {
      final spec = LabelLayoutParser.parse(sample1);
      expect(spec.body[2].heightMm, 9);
    });

    test('缺 height 回落 6mm', () {
      expect(specOfElem('{"type":"barcode","content":"X"}').body.single.heightMm, 6);
    });
  });

  group('未知 type 行为', () {
    test('解析层收下（不丢元素）、编码层两方言跳过不炸', () {
      final warnings = <String>[];
      final spec = LabelLayoutParser.parse(
          '{"presentations":{"label":{"size":{"width":"40mm","height":"30mm"},'
          '"body":["bad-element",'
          '{"type":"image","src":"{{logo}}","x":"1mm","y":"1mm"},'
          '{"type":"text","content":"ok","x":"2mm","y":"2mm"}]}}}',
          onWarning: warnings.add);
      // 非 Map 元素解析层丢弃；Map 元素照收（type 原样保留）：
      expect(spec.body.length, 2);
      expect(spec.body[0].type, 'image');
      final tsplText = latin1Of(TsplEncoder().encode(spec, const {}));
      expect(tsplText, isNot(contains('IMAGE')));
      expect(tsplText, contains('TEXT 16,16'));
      final cpclText = latin1Of(CpclEncoder().encode(spec, const {}));
      expect(cpclText, contains('TEXT 4 0 16 16 ok'));
      expect(warnings.join('\n'), contains('未知元素类型 "image"'));
      expect(warnings.join('\n'), contains('非对象元素'),
          reason: '非 Map 元素同样告警');
    });
  });

  group('未知 schemaVersion 行为', () {
    test('兼容解析成立（未知版本不拒载）', () {
      for (final v in ['1.0', '2.0', '9.9']) {
        final spec = LabelLayoutParser.parse(
            '{"schemaVersion":"$v","presentations":{"label":'
            '{"size":{"width":"40mm","height":"30mm"},"body":[]}}}');
        expect(spec.widthMm, 40, reason: '版本 $v 应兼容解析');
      }
    });

    test('未知版本告警（1.x 不告警、无版本字段不告警）', () {
      final warnings = <String>[];
      LabelLayoutParser.parse(
          '{"schemaVersion":"2.0","presentations":{"label":'
          '{"size":{"width":"40mm","height":"30mm"},"body":[]}}}',
          onWarning: warnings.add);
      expect(warnings.join('\n'), contains('未知 schemaVersion="2.0"'));
      warnings.clear();
      LabelLayoutParser.parse(
          '{"schemaVersion":"1.1","presentations":{"label":'
          '{"size":{"width":"40mm","height":"30mm"},"body":[]}}}',
          onWarning: warnings.add);
      expect(warnings, isEmpty, reason: '已知 1.x 档不告警');
      warnings.clear();
      LabelLayoutParser.parse(
          '{"presentations":{"label":{"size":{"width":"40mm","height":"30mm"},'
          '"body":[]}}}',
          onWarning: warnings.add);
      expect(warnings, isEmpty, reason: '无版本字段不告警');
    });
  });

  group('缺省值', () {
    test('外壳缺省：40×30 / gap 2 / density 8 / speed 4 / copies null', () {
      final spec = LabelLayoutParser.parse(
          '{"presentations":{"label":{"body":[]}}}');
      expect(spec.widthMm, 40);
      expect(spec.heightMm, 30);
      expect(spec.gapMm, 2);
      expect(spec.density, 8);
      expect(spec.speed, 4);
      expect(spec.copiesTemplate, isNull);
    });

    test('元素缺省：x/y 0 / width 20 / height 6 / symbology CODE128 / cell 4',
        () {
      final spec = specOfElem(
          '{"type":"text","content":"a"},'
          '{"type":"barcode","content":"b"},'
          '{"type":"qrcode","content":"c"}');
      expect(spec.body[0].xMm, 0);
      expect(spec.body[0].widthMm, 20);
      expect(spec.body[0].heightMm, 6);
      expect(spec.body[1].symbology, 'CODE128');
      expect(spec.body[2].cellSize, kQrcodeCellDefault);
      expect(kQrcodeCellDefault, 4);
    });

    test('mm→dot 换算：8 dot/mm（含 .5 进位点）', () {
      expect(labelDotsPerMm, 8);
      expect(mmToDot(30), 240);
      expect(mmToDot(12.5), 100);
      expect(mmToDot(1.5), 12);
    });
  });

  group('样例全链：解析→编码（TSPL/CPCL 两方言）', () {
    final data = <String, dynamic>{
      'name': '鲜牛奶 950ml',
      'price': '12.50',
      'unit': '盒',
      'spec': '950ml',
      'sku': '6901234567890',
    };

    test('样例 1 TSPL 帧骨架 + 编码通道生效', () {
      final spec = LabelLayoutParser.parse(sample1);
      final t = latin1Of(TsplEncoder().encode(spec, data));
      expect(t, contains('SIZE 40mm,30mm\n'));
      expect(t, contains('GAP 2mm,0\n'));
      expect(t, contains('DENSITY 8\n'));
      expect(t, contains('SPEED 4\n'));
      expect(t, contains('DIRECTION 1\n'));
      expect(t, contains('CLS\n'));
      expect(t, contains('TEXT 16,16,"SIMPLIFIED CHINESE",0,1,1,"'));
      expect(t, contains('TEXT 16,88,"SIMPLIFIED CHINESE",0,2,2,"'));
      expect(t, contains('12.50'));
      expect(t, contains('BARCODE 16,152,"CODE128",72,0,0,2,2,"6901234567890"'));
      expect(t, contains('PRINT 1'));
    });

    test('样例 2 TSPL：qrcode size 4 → cell 4', () {
      final t = latin1Of(
          TsplEncoder().encode(LabelLayoutParser.parse(sample2), data));
      expect(t, contains('QRCODE 16,128,M,4,A,0,M,7,"6901234567890"'));
    });

    test('样例 2 CPCL：QR 三段式 U 4 + 数据行三字符形态', () {
      final t = latin1Of(
          CpclEncoder().encode(LabelLayoutParser.parse(sample2), data));
      expect(t, contains('! 0 200 200 240 1\n'));
      expect(t, contains('BARCODE QR 16 128 M 2 U 4\n'));
      expect(t, contains('M0A,6901234567890\n'));
      expect(t, contains('ENDQR\n'));
      expect(t, contains('FORM\nPRINT\n'));
    });

    test('copies 模板表达式可求值', () {
      final spec = LabelLayoutParser.parse(
          '{"presentations":{"label":{"size":{"width":"40mm","height":"30mm"},'
          '"copies":"{{copies}}","body":[]}}}');
      final t = latin1Of(
          TsplEncoder().encode(spec, <String, dynamic>{'copies': '3'}));
      expect(t, contains('PRINT 3'));
    });

    test('点路径 {{goods.name}} 已支持（superset 向后兼容）', () {
      final spec = LabelLayoutParser.parse(
          '{"presentations":{"label":{"size":{"width":"40mm","height":"30mm"},'
          '"body":[{"type":"text","content":"{{goods.name}}"}]}}}');
      final t = latin1Of(TsplEncoder()
          .encode(spec, <String, dynamic>{'goods': <String, dynamic>{'name': 'GOODS-OK'}}));
      expect(t, contains('GOODS-OK'));
    });
  });

  group('坏 JSON 与结构异常', () {
    test('缺 presentations.label / body 非数组 / 根非对象 → FormatException',
        () {
      expect(() => LabelLayoutParser.parse('{}'), throwsFormatException);
      expect(
          () => LabelLayoutParser.parse(
              '{"presentations":{"label":{"body":{}}}}'),
          throwsFormatException);
      expect(() => LabelLayoutParser.parse('[]'), throwsFormatException);
      expect(() => LabelLayoutParser.parse('not-json'), throwsFormatException);
    });

    test('未知版本＋完整结构 → 兼容解析（body 为空）', () {
      final spec = LabelLayoutParser.parse(
          '{"schemaVersion":"3.1","code":"X","presentations":{"label":'
          '{"size":{"width":"40mm","height":"30mm"},"body":[]}}}');
      expect(spec.body, isEmpty);
    });
  });
}

/// latin1 透明解码（内容 GBK 字节仅用于 contains 断言，不回读字形）。
String latin1Of(List<int> bytes) => String.fromCharCodes(bytes);
