// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ExpressionCompiler, ExpressionSyntaxError } from '../src/index';

// ExpressionCompiler：JS 表达式 + Liquid 管道，
// 沙箱（白名单操作符/过滤器、单表达式 ≤1KB、求值超时）。
// 跨语言一致性锚点：本套件断言的语义 C#/Dart 端落地时必须复现。

const run = (expr: string, data: object = {}): unknown =>
  ExpressionCompiler.evaluate(ExpressionCompiler.compile(expr), data, 100);

describe('ExpressionCompiler.compile（文法）', () => {
  it('字面量/路径/索引的 AST 形态', () => {
    expect(ExpressionCompiler.compile('42').root).toEqual({ kind: 'literal', value: 42 });
    expect(ExpressionCompiler.compile('customer.name').root).toEqual({
      kind: 'path',
      segments: ['customer', 'name'],
    });
    expect(ExpressionCompiler.compile('items[0].sku').root).toEqual({
      kind: 'path',
      segments: ['items', 0, 'sku'],
    });
    expect(ExpressionCompiler.compile('billNo').raw).toBe('billNo');
  });

  it('通配符 [*] 不参与表达式文法（仅字段字典展示形态）', () => {
    expect(() => ExpressionCompiler.compile('items[*].sku')).toThrow(ExpressionSyntaxError);
  });

  it('未知过滤器/非整数索引/未闭合字符串/非法字符均拒绝', () => {
    expect(() => ExpressionCompiler.compile('x | nope:1')).toThrow(/未知过滤器/);
    expect(() => ExpressionCompiler.compile('items[0.5]')).toThrow(ExpressionSyntaxError);
    expect(() => ExpressionCompiler.compile("'abc")).toThrow(/未闭合/);
    expect(() => ExpressionCompiler.compile('a @ b')).toThrow(/非法字符/);
  });

  it('沙箱限额：单表达式 ≤1KB（）', () => {
    expect(() => ExpressionCompiler.compile('a'.repeat(1025))).toThrow(/沙箱限额/);
    expect(ExpressionCompiler.compile('a'.repeat(1024)).root.kind).toBe('path');
  });
});

describe('ExpressionCompiler.evaluate（语义）', () => {
  it('四则运算与优先级（FR-01.4）', () => {
    expect(run('qty * price | round:2', { qty: 3, price: 19.9 })).toBe(59.7);
    expect(run('totalAmount - discount', { totalAmount: 100, discount: 15.5 })).toBe(84.5);
    expect(run('2 + 3 * 4')).toBe(14);
    expect(run('(2 + 3) * 4')).toBe(20);
    expect(run('-qty', { qty: 3 })).toBe(-3);
  });

  it('payslip 债务表达式（PHASE2_EXPRESSION_DEBT 清零锚点）', () => {
    expect(
      run('baseSalary + bonus + overtime | currency:CNY', {
        baseSalary: 8000,
        bonus: 1200.5,
        overtime: 340.25,
      }),
    ).toBe('¥9,540.75');
  });

  it('比较/逻辑/三元（条件判断）', () => {
    const data = { paidAmount: 80, totalAmount: 100 };
    expect(run("paidAmount < totalAmount ? '欠款' : '已付'", data)).toBe('欠款');
    expect(
      run("paidAmount >= totalAmount ? '已付' : '欠款'", { paidAmount: 100, totalAmount: 100 }),
    ).toBe('已付');
    expect(run('a && b', { a: true, b: 'x' })).toBe('x');
    expect(run('a || b', { a: '', b: 'fallback' })).toBe('fallback');
    expect(run("5 == '5'")).toBe(true);
    expect(run("5 === '5'")).toBe(false);
  });

  it('字符串拼接', () => {
    expect(run("'单号：' + billNo", { billNo: 'XS20260808001' })).toBe('单号：XS20260808001');
  });

  it('路径解析：嵌套/索引/缺失即 undefined', () => {
    const data = { customer: { name: '张三' }, items: [{ sku: 'A-01' }, { sku: 'B-02' }] };
    expect(run('customer.name', data)).toBe('张三');
    expect(run('items[0].sku', data)).toBe('A-01');
    expect(run('items[1].sku', data)).toBe('B-02');
    expect(run('items[2].sku', data)).toBeUndefined();
    expect(run('customer.phone', data)).toBeUndefined();
  });

  it('过滤管道：date/currency/round/sum/count/truncate/mask（七例）', () => {
    expect(run("d | date:'YYYY-MM-DD'", { d: '2026-08-08T10:00:00Z' })).toBe('2026-08-08');
    expect(run('amount | currency:CNY', { amount: 1234.5 })).toBe('¥1,234.50');
    expect(run('v | round:2', { v: 3.14159 })).toBe(3.14);
    expect(run("items | sum:'amount'", { items: [{ amount: 10 }, { amount: 2.5 }] })).toBe(12.5);
    expect(run('items | count', { items: [1, 2, 3] })).toBe(3);
    expect(run('remark | truncate:4', { remark: '备注很长很长' })).toBe('备注很长...');
    expect(run("phone | mask:'138****8888'", { phone: '13812348888' })).toBe('138****8888');
    expect(run("phone | mask:'138****8888'", { phone: '13999997777' })).toBe('139****7777');
    expect(run("v | default:'-'", {})).toBe('-');
    expect(run("v | default:'-'", { v: '' })).toBe('-');
    expect(run("v | default:'-'", { v: 'x' })).toBe('x');
  });

  it('过滤器链式应用（左→右）', () => {
    expect(run('qty * price | round:1 | currency:CNY', { qty: 3, price: 19.9 })).toBe('¥59.70');
  });

  it('自定义函数由宿主经 data 注入（now()/tenantName() 等）', () => {
    expect(run('tenantName()', { tenantName: () => '示例门店' })).toBe('示例门店');
    expect(() => run('now()')).toThrow(/未注册函数/);
  });

  it('evaluate 防御：AST 形态与 timeout 校验', () => {
    expect(() => ExpressionCompiler.evaluate({ raw: 'x' } as never, {}, 100)).toThrow(TypeError);
    const ast = ExpressionCompiler.compile('x');
    expect(() => ExpressionCompiler.evaluate(ast, {}, 0)).toThrow(TypeError);
    expect(() => ExpressionCompiler.evaluate(ast, {}, Number.NaN)).toThrow(TypeError);
  });
});

describe('ExpressionCompiler.extractFields（字段联动校验）', () => {
  it('提取路径引用（含索引段，去重保序）', () => {
    const ast = ExpressionCompiler.compile(
      'items[0].sku + items[1].sku + billNo + (billNo | truncate:5)',
    );
    expect(ExpressionCompiler.extractFields(ast)).toEqual(['items.0.sku', 'items.1.sku', 'billNo']);
  });

  it('字面量/函数名不计入字段', () => {
    expect(ExpressionCompiler.extractFields(ExpressionCompiler.compile("now() + 'x'"))).toEqual([]);
  });
});

describe('严格化语义（求值安全与聚合函数补全）', () => {
  it('V3：== 与 JS 对齐——boolean↔number/数字字符串（=== 仍严格）', () => {
    expect(run('flag == 1', { flag: true })).toBe(true);
    expect(run('flag == 0', { flag: false })).toBe(true);
    expect(run("flag == '1'", { flag: true })).toBe(true);
    expect(run('flag == 2', { flag: true })).toBe(false);
    expect(run('flag === 1', { flag: true })).toBe(false);
  });

  it('V5：currency 补 HKD/KRW/TWD 符号（出海场景）', () => {
    expect(run('amount | currency:HKD', { amount: 12 })).toBe('HK$12.00');
    expect(run('amount | currency:KRW', { amount: 12 })).toBe('₩12.00');
    expect(run('amount | currency:TWD', { amount: 12 })).toBe('NT$12.00');
  });

  it('V6：过滤器参数类型/个数编译期即拒（不落到求值期静默降级）', () => {
    expect(() => ExpressionCompiler.compile('amount | currency:123')).toThrow(/必须是字符串/);
    expect(() => ExpressionCompiler.compile('v | truncate:"5"')).toThrow(/必须是数字/);
    expect(() => ExpressionCompiler.compile('v | round:2:3')).toThrow(/最多接受/);
    expect(() => ExpressionCompiler.compile('items | count:1')).toThrow(/最多接受/);
  });

  it('V7：date 格式未识别占位符编译期即拒（小写 yyyy 等静默错误杜绝）', () => {
    expect(() => ExpressionCompiler.compile("d | date:'yyyy-mm-dd'")).toThrow(/未识别占位符/);
    expect(() => ExpressionCompiler.compile("d | date:'YYYY年MM月DD日'")).not.toThrow();
    expect(run("d | date:'YYYY年MM月'", { d: '2026-08-08T10:00:00Z' })).toBe('2026年08月');
  });

  it('聚合补全：avg/min/max（跳过非数值；无数值返回空串）', () => {
    const data = { items: [{ q: 2 }, { q: 4 }, { q: 'x' }] };
    expect(run("items | avg:'q'", data)).toBe(3);
    expect(run("items | min:'q'", data)).toBe(2);
    expect(run("items | max:'q'", data)).toBe(4);
    expect(run('items | avg', { items: ['a'] })).toBe('');
  });
});

describe('严格化语义二（原型链防护/转义语义/比较边界）', () => {
  it('P2：原型链穿透防护 golden——constructor/__proto__/toString 一律不可达', () => {
    expect(run('constructor.name')).toBeUndefined();
    expect(run('constructor.name', { billNo: 'X-1' })).toBeUndefined();
    expect(run('__proto__')).toBeUndefined();
    expect(run('toString')).toBeUndefined();
    expect(run('hasOwnProperty')).toBeUndefined();
    // 继承成员也不可被当作宿主函数调用
    expect(() => run('constructor()')).toThrow(/未注册函数/);
    expect(() => run('toString()')).toThrow(/未注册函数/);
    // 自有同名属性不受防护影响（宿主显式注入仍然可达）
    expect(run('constructor.name', { constructor: { name: '自定义' } })).toBe('自定义');
  });

  it('P2：字符串转义白名单——\\n \\t \\r \\\\ \' " 有定义，未知转义编译期拒绝', () => {
    expect(run("'a\\nb'")).toBe('a\nb');
    expect(run("'a\\tb'")).toBe('a\tb');
    expect(run("'a\\rb'")).toBe('a\rb');
    expect(run("'a\\\\b'")).toBe('a\\b');
    expect(run("'it\\'s ok'")).toBe("it's ok");
    expect(run('"say \\"hi\\""')).toBe('say "hi"');
    expect(() => ExpressionCompiler.compile("'a\\qb'")).toThrow(/未知转义序列/);
    expect(() => ExpressionCompiler.compile('"\\x41"')).toThrow(/未知转义序列/);
  });

  it('比较语义边界 fixture 锁定', () => {
    // 数字字符串与数字比较按 JS 语义转数值；双侧字符串则字典序
    expect(run("'10' > 9")).toBe(true);
    expect(run("'2' < '10'")).toBe(false);
    expect(run("'2' < '10' ? 'dict' : 'num'")).toBe('num');
    // 数字字符串 == 数字按数值比较；null/undefined 不做 JS 式互转（显式不跟随）
    expect(run("'5' == 5")).toBe(true);
    expect(run('a == null', {})).toBe(false);
    expect(run('null == null')).toBe(true);
  });
});

describe('十四轮规范裁决：过滤器可选参数契约与实现的缺省语义对齐）', () => {
  it('sum/avg/min/max 无参数 = 对整个数组元素求值', () => {
    expect(run('nums | sum', { nums: [1, 2, 3.5] })).toBe(6.5);
    expect(run('nums | avg', { nums: [1, 2, 3] })).toBe(2);
    expect(run('nums | min', { nums: [4, 2] })).toBe(2);
    expect(run('nums | max', { nums: [4, 2] })).toBe(4);
  });

  it('其余过滤器无参数走文档化缺省（date/currency/round/truncate）', () => {
    expect(run('d | date', { d: '2026-08-08T10:00:00Z' })).toBe('2026-08-08');
    expect(run('amount | currency', { amount: 12 })).toBe('¥12.00');
    expect(run('v | round', { v: 3.7 })).toBe(4);
    expect(run('s | truncate', { s: 'x'.repeat(25) })).toBe(`${'x'.repeat(20)}...`);
  });

  it('参数类型错误仍编译期拒绝（可选≠放松类型契约）', () => {
    expect(() => ExpressionCompiler.compile('items | sum:123')).toThrow(/必须是字符串/);
    expect(() => ExpressionCompiler.compile('v | round:"2"')).toThrow(/必须是数字/);
    expect(() => ExpressionCompiler.compile('nums | sum:x:y')).toThrow(/最多接受/);
  });
});
