// SPDX-License-Identifier: Apache-2.0
// 表达式编译/求值（与 C#/Dart/Java 同构）。
// 求值安全：递归下降解析 + 解释执行，不使用 eval/new Function；操作符/过滤器均为白名单。
// 多语言实现（TS/C#/Dart）必须复现同语义。
import type { ExpressionAST, ExpressionNode } from './types.ts';

/** 沙箱限额 */
const MAX_EXPR_BYTES = 1024;
const MAX_AST_DEPTH = 64;

export class ExpressionSyntaxError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
    this.name = 'ExpressionSyntaxError';
  }
}

type Token =
  | { type: 'num'; value: number; pos: number }
  | { type: 'str'; value: string; pos: number }
  | { type: 'ident'; value: string; pos: number }
  | { type: 'punct'; value: string; pos: number };

const PUNCT = [
  '===',
  '!==',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '!',
  '?',
  ':',
  '(',
  ')',
  '[',
  ']',
  '.',
  ',',
  '|',
];

/**
 * 字符串转义白名单（二轮规范裁决：多语言实现同构必须逐字复现，未列出的转义编译期即拒）。
 * \n 换行 / \t 制表符 / \r 回车 / \\ 反斜杠 / \' \" 引号字面量。
 */
const STRING_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '\\': '\\',
  "'": "'",
  '"': '"',
};

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      const m = /^\d+(\.\d+)?/.exec(src.slice(i));
      tokens.push({ type: 'num', value: Number(m![0]), pos: i });
      i += m![0].length;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let out = '';
      let j = i + 1;
      let closed = false;
      while (j < src.length) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const mapped = STRING_ESCAPES[src[j + 1]];
          if (mapped === undefined) {
            throw new ExpressionSyntaxError(`未知转义序列：\\${src[j + 1]}`, i);
          }
          out += mapped;
          j += 2;
          continue;
        }
        if (src[j] === quote) {
          closed = true;
          break;
        }
        out += src[j];
        j++;
      }
      if (!closed) throw new ExpressionSyntaxError('字符串未闭合', i);
      tokens.push({ type: 'str', value: out, pos: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i));
      tokens.push({ type: 'ident', value: m![0], pos: i });
      i += m![0].length;
      continue;
    }
    const punct = PUNCT.find((p) => src.startsWith(p, i));
    if (punct) {
      tokens.push({ type: 'punct', value: punct, pos: i });
      i += punct.length;
      continue;
    }
    throw new ExpressionSyntaxError(`非法字符：${ch}`, i);
  }
  return tokens;
}

/** 内置过滤器白名单 */
const FILTERS = new Set([
  'date',
  'currency',
  'round',
  'sum',
  'avg',
  'min',
  'max',
  'count',
  'truncate',
  'mask',
  'default',
]);

/**
 * 过滤器参数编译期类型契约。空数组 = 不允许参数；'any' = 不限类型；
 * 尾缀 '?' = 可选参数（十四轮规范裁决：规则表须与实现的缺省分支一致）。
 * 无参数时的求值缺省：date→'YYYY-MM-DD'、currency→CNY、round→0 位、
 * sum/avg/min/max→对整个数组元素求值、truncate→20、mask→全掩、default→''。
 */
const FILTER_ARG_RULES: Record<
  string,
  Array<'string' | 'number' | 'any' | 'string?' | 'number?' | 'any?'>
> = {
  date: ['string?'],
  currency: ['string?'],
  round: ['number?'],
  sum: ['string?'],
  avg: ['string?'],
  min: ['string?'],
  max: ['string?'],
  count: [],
  truncate: ['number?'],
  mask: ['string?'],
  default: ['any?'],
};

/** date 格式合法占位符 */
const DATE_TOKENS = ['YYYY', 'MM', 'DD', 'HH', 'mm', 'ss'];

function checkDateFormat(fmt: string, pos: number): void {
  let i = 0;
  while (i < fmt.length) {
    const tok = DATE_TOKENS.find((t) => fmt.startsWith(t, i));
    if (tok) {
      i += tok.length;
      continue;
    }
    if (/[A-Za-z]/.test(fmt[i])) {
      const run = /^[A-Za-z]+/.exec(fmt.slice(i))![0];
      throw new ExpressionSyntaxError(
        `date 格式含未识别占位符 "${run}"（合法占位符：YYYY/MM/DD/HH/mm/ss，大小写敏感）`,
        pos,
      );
    }
    i++;
  }
}

class Parser {
  private i = 0;
  constructor(private tokens: Token[]) {}

  parse(): ExpressionNode {
    const node = this.parseFilters();
    if (this.i < this.tokens.length) {
      throw new ExpressionSyntaxError('表达式存在未消费的记号', this.tokens[this.i].pos);
    }
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }

  private isPunct(value: string): boolean {
    const t = this.peek();
    return !!t && t.type === 'punct' && t.value === value;
  }

  private eatPunct(value: string): boolean {
    if (this.isPunct(value)) {
      this.i++;
      return true;
    }
    return false;
  }

  private expectPunct(value: string): void {
    if (!this.eatPunct(value)) {
      const t = this.peek();
      throw new ExpressionSyntaxError(`缺少 "${value}"`, t ? t.pos : -1);
    }
  }

  /** 过滤管道绑定最松：expr | name:arg1:arg2 */
  private parseFilters(): ExpressionNode {
    let node = this.parseTernary();
    while (this.eatPunct('|')) {
      const nameTok = this.peek();
      if (!nameTok || nameTok.type !== 'ident') {
        throw new ExpressionSyntaxError('过滤器名必须是标识符', nameTok ? nameTok.pos : -1);
      }
      this.i++;
      if (!FILTERS.has(nameTok.value)) {
        throw new ExpressionSyntaxError(`未知过滤器：${nameTok.value}`, nameTok.pos);
      }
      const args: ExpressionNode[] = [];
      while (this.eatPunct(':')) {
        const arg = this.peek();
        // 示例 {{ amount | currency:CNY }}：裸标识符参数按字符串字面量处理
        // 
        if (!arg || (arg.type !== 'str' && arg.type !== 'num' && arg.type !== 'ident')) {
          throw new ExpressionSyntaxError(
            '过滤器参数必须是字符串/数字/裸标识符字面量',
            arg ? arg.pos : -1,
          );
        }
        this.i++;
        args.push({ kind: 'literal', value: arg.value });
      }
      const rule = FILTER_ARG_RULES[nameTok.value] ?? [];
      if (args.length > rule.length) {
        throw new ExpressionSyntaxError(
          `过滤器 ${nameTok.value} 最多接受 ${rule.length} 个参数`,
          nameTok.pos,
        );
      }
      args.forEach((a, idx) => {
        const expect = rule[idx]?.replace(/\?$/, '');
        if (expect === undefined || expect === 'any') return;
        const value = (a as Extract<ExpressionNode, { kind: 'literal' }>).value;
        if (expect === 'string' && typeof value !== 'string') {
          throw new ExpressionSyntaxError(
            `过滤器 ${nameTok.value} 第 ${idx + 1} 个参数必须是字符串`,
            nameTok.pos,
          );
        }
        if (expect === 'number' && typeof value !== 'number') {
          throw new ExpressionSyntaxError(
            `过滤器 ${nameTok.value} 第 ${idx + 1} 个参数必须是数字`,
            nameTok.pos,
          );
        }
      });
      if (nameTok.value === 'date' && args.length > 0) {
        checkDateFormat(
          (args[0] as Extract<ExpressionNode, { kind: 'literal' }>).value as string,
          nameTok.pos,
        );
      }
      node = { kind: 'filter', value: node, name: nameTok.value, args };
    }
    return node;
  }

  private parseTernary(): ExpressionNode {
    const test = this.parseBinary(0);
    if (this.eatPunct('?')) {
      const consequent = this.parseTernary();
      this.expectPunct(':');
      const alternate = this.parseTernary();
      return { kind: 'ternary', test, consequent, alternate };
    }
    return test;
  }

  private static readonly PRECEDENCE: string[][] = [
    ['||'],
    ['&&'],
    ['==', '!=', '===', '!=='],
    ['<', '<=', '>', '>='],
    ['+', '-'],
    ['*', '/', '%'],
  ];

  private parseBinary(level: number): ExpressionNode {
    if (level >= Parser.PRECEDENCE.length) return this.parseUnary();
    let left = this.parseBinary(level + 1);
    const ops = Parser.PRECEDENCE[level];
    for (;;) {
      const t = this.peek();
      if (t && t.type === 'punct' && ops.includes(t.value)) {
        this.i++;
        const right = this.parseBinary(level + 1);
        left = { kind: 'binary', op: t.value as never, left, right };
        continue;
      }
      return left;
    }
  }

  private parseUnary(): ExpressionNode {
    const t = this.peek();
    if (t && t.type === 'punct' && (t.value === '-' || t.value === '+' || t.value === '!')) {
      this.i++;
      return { kind: 'unary', op: t.value, operand: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): ExpressionNode {
    let node = this.parsePrimary();
    for (;;) {
      if (this.eatPunct('.')) {
        const t = this.peek();
        if (!t || t.type !== 'ident') {
          throw new ExpressionSyntaxError('"." 后必须是标识符', t ? t.pos : -1);
        }
        this.i++;
        node = this.appendSegment(node, t.value);
        continue;
      }
      if (this.eatPunct('[')) {
        const t = this.peek();
        if (!t || t.type !== 'num' || !Number.isInteger(t.value)) {
          throw new ExpressionSyntaxError(
            '索引仅支持非负整数（通配符 [*] 不参与表达式文法）',
            t ? t.pos : -1,
          );
        }
        this.i++;
        this.expectPunct(']');
        node = this.appendSegment(node, t.value);
        continue;
      }
      return node;
    }
  }

  /** path 追加段；非 path 节点（如函数返回值）不允许继续取成员 */
  private appendSegment(node: ExpressionNode, seg: string | number): ExpressionNode {
    if (node.kind !== 'path') {
      throw new ExpressionSyntaxError('仅字段路径支持成员/索引访问', -1);
    }
    return { kind: 'path', segments: [...node.segments, seg] };
  }

  private parsePrimary(): ExpressionNode {
    const t = this.peek();
    if (!t) throw new ExpressionSyntaxError('表达式意外结束', -1);
    if (t.type === 'num' || t.type === 'str') {
      this.i++;
      return { kind: 'literal', value: t.value };
    }
    if (t.type === 'punct' && t.value === '(') {
      this.i++;
      const node = this.parseFilters();
      this.expectPunct(')');
      return node;
    }
    if (t.type === 'ident') {
      this.i++;
      if (t.value === 'true' || t.value === 'false')
        return { kind: 'literal', value: t.value === 'true' };
      if (t.value === 'null') return { kind: 'literal', value: null };
      if (this.isPunct('(')) {
        this.i++;
        const args: ExpressionNode[] = [];
        if (!this.isPunct(')')) {
          for (;;) {
            args.push(this.parseTernary());
            if (this.eatPunct(',')) continue;
            break;
          }
        }
        this.expectPunct(')');
        return { kind: 'call', name: t.value, args };
      }
      return { kind: 'path', segments: [t.value] };
    }
    throw new ExpressionSyntaxError('意外的记号', t.pos);
  }
}

function checkDepth(node: ExpressionNode, depth: number): void {
  if (depth > MAX_AST_DEPTH) throw new ExpressionSyntaxError('表达式嵌套过深', -1);
  switch (node.kind) {
    case 'unary':
      checkDepth(node.operand, depth + 1);
      break;
    case 'binary':
      checkDepth(node.left, depth + 1);
      checkDepth(node.right, depth + 1);
      break;
    case 'ternary':
      checkDepth(node.test, depth + 1);
      checkDepth(node.consequent, depth + 1);
      checkDepth(node.alternate, depth + 1);
      break;
    case 'filter':
      checkDepth(node.value, depth + 1);
      break;
    case 'call':
      for (const a of node.args) checkDepth(a, depth + 1);
      break;
    default:
      break;
  }
}

// ---------- 求值 ----------

type Data = Record<string, unknown>;

interface EvalCtx {
  data: Data;
  deadline: number;
  ticks: number;
}

function tick(ctx: EvalCtx): void {
  if (++ctx.ticks % 128 === 0 && Date.now() > ctx.deadline) {
    throw new Error('表达式求值超时（沙箱限额）');
  }
}

function resolvePath(segments: Array<string | number>, data: Data): unknown {
  let cur: unknown = data;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    // 原型链防护（二轮规范裁决）：仅读自有属性——constructor.name/__proto__ 等
    // 继承成员一律返回 undefined，杜绝 Object.prototype 穿透（多语言实现同口径）
    if (typeof cur !== 'object' || !Object.hasOwn(cur as object, seg)) return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

// 宽松相等（== 语义，规范裁决：与 JS == 对齐——boolean 先转数字再比较，
// true == 1 / false == 0 / true == '1' 均成立；=== 保持严格）
function looseEquals(a: unknown, b: unknown): boolean {
  if (typeof a === 'boolean') return looseEquals(a ? 1 : 0, b);
  if (typeof b === 'boolean') return looseEquals(a, b ? 1 : 0);
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'string') return a === Number(b);
  if (typeof b === 'number' && typeof a === 'string') return b === Number(a);
  return false;
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null) return 0;
  return NaN;
}

function evalNode(node: ExpressionNode, ctx: EvalCtx): unknown {
  tick(ctx);
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'path':
      return resolvePath(node.segments, ctx.data);
    case 'unary': {
      const v = evalNode(node.operand, ctx);
      if (node.op === '!') return !v;
      return node.op === '-' ? -toNumber(v) : toNumber(v);
    }
    case 'binary':
      return evalBinary(node, ctx);
    case 'ternary':
      return evalNode(evalNode(node.test, ctx) ? node.consequent : node.alternate, ctx);
    case 'filter':
      return applyFilter(node, ctx);
    case 'call': {
      // 原型链防护（同 resolvePath）：仅自有属性可注册为函数
      const fn = Object.hasOwn(ctx.data, node.name) ? ctx.data[node.name] : undefined;
      if (typeof fn !== 'function') {
        throw new Error(`未注册函数：${node.name}（自定义函数须由宿主注入求值上下文）`);
      }
      return (fn as (...args: unknown[]) => unknown)(...node.args.map((a) => evalNode(a, ctx)));
    }
    default:
      throw new Error('未知 AST 节点');
  }
}

function evalBinary(node: Extract<ExpressionNode, { kind: 'binary' }>, ctx: EvalCtx): unknown {
  if (node.op === '&&') return evalNode(node.left, ctx) && evalNode(node.right, ctx);
  if (node.op === '||') return evalNode(node.left, ctx) || evalNode(node.right, ctx);
  const l = evalNode(node.left, ctx);
  const r = evalNode(node.right, ctx);
  switch (node.op) {
    case '===':
      return l === r;
    case '!==':
      return l !== r;
    case '==':
      return looseEquals(l, r);
    case '!=':
      return !looseEquals(l, r);
    case '<':
      return (l as never) < (r as never);
    case '<=':
      return (l as never) <= (r as never);
    case '>':
      return (l as never) > (r as never);
    case '>=':
      return (l as never) >= (r as never);
    case '+':
      if (typeof l === 'string' || typeof r === 'string') return `${l ?? ''}${r ?? ''}`;
      return toNumber(l) + toNumber(r);
    case '-':
      return toNumber(l) - toNumber(r);
    case '*':
      return toNumber(l) * toNumber(r);
    case '/':
      return toNumber(l) / toNumber(r);
    case '%':
      return toNumber(l) % toNumber(r);
    default:
      throw new Error(`未知操作符：${node.op}`);
  }
}

// ---------- 过滤器 ----------

const CURRENCY_SYMBOL: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: 'JP¥',
  HKD: 'HK$',
  KRW: '₩',
  TWD: 'NT$',
};

function formatNumber(v: number, digits: number): string {
  const fixed = v.toFixed(digits);
  const [int, frac] = fixed.split('.');
  const negative = int.startsWith('-');
  const digitsOnly = negative ? int.slice(1) : int;
  const grouped = digitsOnly.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

function toDate(v: unknown): Date | undefined {
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

function formatDate(d: Date, fmt: string): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return fmt
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/MM/g, pad(d.getMonth() + 1))
    .replace(/DD/g, pad(d.getDate()))
    .replace(/HH/g, pad(d.getHours()))
    .replace(/mm/g, pad(d.getMinutes()))
    .replace(/ss/g, pad(d.getSeconds()));
}

function literalArgs(node: Extract<ExpressionNode, { kind: 'filter' }>, ctx: EvalCtx): unknown[] {
  return node.args.map((a) => evalNode(a, ctx));
}

function applyFilter(node: Extract<ExpressionNode, { kind: 'filter' }>, ctx: EvalCtx): unknown {
  const v = evalNode(node.value, ctx);
  const args = literalArgs(node, ctx);
  switch (node.name) {
    case 'date': {
      const d = toDate(v);
      if (!d) return '';
      return formatDate(d, typeof args[0] === 'string' ? args[0] : 'YYYY-MM-DD');
    }
    case 'currency': {
      const n = toNumber(v);
      if (Number.isNaN(n)) return '';
      if (args.length > 0 && typeof args[0] !== 'string') {
        throw new Error('currency 过滤器参数必须是币种代码字符串（编译期已校，此为防御分支）');
      }
      const code = (args[0] as string | undefined) ?? 'CNY';
      return `${CURRENCY_SYMBOL[code] ?? `${code} `}${formatNumber(n, 2)}`;
    }
    case 'round': {
      const n = toNumber(v);
      if (Number.isNaN(n)) return '';
      const digits = typeof args[0] === 'number' ? args[0] : 0;
      const factor = 10 ** digits;
      return Math.round(n * factor) / factor;
    }
    case 'sum': {
      if (!Array.isArray(v)) return '';
      const field = typeof args[0] === 'string' ? args[0] : undefined;
      return v.reduce<number>((acc, item) => {
        const raw = field ? (item as Data | null)?.[field] : item;
        const n = toNumber(raw);
        return acc + (Number.isNaN(n) ? 0 : n);
      }, 0);
    }
    case 'avg':
    case 'min':
    case 'max': {
      if (!Array.isArray(v)) return '';
      const field = typeof args[0] === 'string' ? args[0] : undefined;
      const nums: number[] = [];
      for (const item of v) {
        const raw = field ? (item as Data | null)?.[field] : item;
        const n = toNumber(raw);
        if (!Number.isNaN(n)) nums.push(n);
      }
      if (nums.length === 0) return '';
      if (node.name === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length;
      return node.name === 'min' ? Math.min(...nums) : Math.max(...nums);
    }
    case 'count':
      return Array.isArray(v) ? v.length : typeof v === 'string' ? v.length : 0;
    case 'truncate': {
      const s = v === null || v === undefined ? '' : String(v);
      const max = typeof args[0] === 'number' ? args[0] : 20;
      if (s.length <= max) return s;
      return `${s.slice(0, max)}...`;
    }
    case 'mask': {
      // pattern 定义掩码版式：'*' 位输出 '*'，其余位透传原文同位字符（不足取 pattern 字符）
      const s = v === null || v === undefined ? '' : String(v);
      const pattern = typeof args[0] === 'string' ? args[0] : '*'.repeat(s.length);
      return pattern
        .split('')
        .map((c, i) => (c === '*' ? '*' : (s[i] ?? c)))
        .join('');
    }
    case 'default': {
      const fallback = args[0];
      if (v === null || v === undefined || v === '') return fallback ?? '';
      return v;
    }
    default:
      throw new Error(`未知过滤器：${node.name}`);
  }
}

// ---------- 对外 API ----------

export class ExpressionCompiler {
  /** 表达式 → AST（沙箱限额：≤1KB、嵌套 ≤64；非法文法抛 ExpressionSyntaxError） */
  static compile(expr: string): ExpressionAST {
    if (typeof expr !== 'string') throw new TypeError('表达式必须是字符串');
    if (new TextEncoder().encode(expr).length > MAX_EXPR_BYTES) {
      throw new ExpressionSyntaxError('表达式超出沙箱限额（1KB）', -1);
    }
    const root = new Parser(tokenize(expr)).parse();
    checkDepth(root, 1);
    return { raw: expr, root };
  }

  /**
   * AST → 求值（沙箱：白名单操作符/过滤器、超时即抛）。
   * 自定义函数由宿主以函数值注入 data。
   */
  static evaluate(ast: ExpressionAST, data: object, timeout: number): unknown {
    if (!ast || typeof ast !== 'object' || !('root' in ast)) {
      throw new TypeError('evaluate 需要 compile 产出的 AST');
    }
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new TypeError('timeout 必须为正数（毫秒）');
    }
    const ctx: EvalCtx = { data: (data ?? {}) as Data, deadline: Date.now() + timeout, ticks: 0 };
    return evalNode(ast.root, ctx);
  }

  /** 列出表达式引用的字段路径（用于字段联动校验；数字索引以点段表示） */
  static extractFields(ast: ExpressionAST): string[] {
    const out: string[] = [];
    const walk = (node: ExpressionNode): void => {
      switch (node.kind) {
        case 'path':
          out.push(node.segments.join('.'));
          break;
        case 'unary':
          walk(node.operand);
          break;
        case 'binary':
          walk(node.left);
          walk(node.right);
          break;
        case 'ternary':
          walk(node.test);
          walk(node.consequent);
          walk(node.alternate);
          break;
        case 'filter':
          walk(node.value);
          break;
        case 'call':
          for (const a of node.args) walk(a);
          break;
        default:
          break;
      }
    };
    walk(ast.root);
    return [...new Set(out)];
  }
}
