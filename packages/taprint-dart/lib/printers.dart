// SPDX-License-Identifier: Apache-2.0
// printers — 打印方言字节编码器（ESC/POS 收据 + TSPL/CPCL 标签）与
// GBK/GB18030 编码通道。纯 Dart，无 Flutter/平台依赖。
//
// 与主入口 print_dsl.dart 的关系：本库的 DslParser / DslElement /
// ExpressionCompiler 是**编码器消费的收据/标签子集**（只读
// presentations.receipt / presentations.label 子树），与 print_dsl.dart
// 导出的内核同名类（全量 DSL 对象树解析、JS 语义沙箱求值器）同名
// 不同物。同时 import 两个入口时请用库前缀（import 'package:taprint/
// printers.dart' as printers;）消歧。
//
// 编码通道默认 GB18030 双字节区全表（gbk_full.dart，oracle 生成锁定，
// ADR-0009）；GbkCodec 常用字子集保留为 fast path（字节与全表逐项
// 一致）。兼容面告警经 PrintersLog 上报（函数注入，默认静默）。
library printers;

export 'src/printers/cpcl_encoder.dart';
export 'src/printers/dsl_parser.dart';
export 'src/printers/escpos_encoder.dart';
export 'src/printers/expression_compiler.dart';
export 'src/printers/gbk_codec.dart';
export 'src/printers/gbk_full.dart' show gbkFullTable, gbkFullTableSize;
export 'src/printers/label_layout.dart';
export 'src/printers/printer_log.dart';
export 'src/printers/tspl_encoder.dart';
export 'src/printers/zpl_encoder.dart';
