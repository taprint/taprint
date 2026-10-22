// SPDX-License-Identifier: Apache-2.0
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using Taprint.PrintDsl.Internal;

// 表达式编译/求值 C# 端（print-dsl-ts expression-compiler.ts 逐行同构移植；
// 语义口径：主文档  JS 表达式 + Liquid 管道、 沙箱； 多语言实现一致锚点）。
// JS 语义复刻关键点（与 TS 逐字对齐，不得 C# 习惯化）：
// - ToNumber('') = NaN（trim 守卫），而 LooseEquals 走 NumberFromString('') = 0（JS Number 语义），两口径分离；
// - Math.round 复刻为 Floor(x + 0.5)（Math.round(-0.5) = -0）；
// - ToFixed ties 远离零（(−0.5).toFixed(0) = "-1"），|x| ≥ 1e21 回退 EcmaNumber.Format；
// - 比较 < <= > >=：双字符串 Ordinal 字典序，否则双侧 ToNumber（NaN 一律 false）；
// - '+' 任一侧 string 即拼接（null → ""，数字经 EcmaNumber.Format）；
// - date 过滤器取本地时区分量（与 JS getFullYear/getMonth… 一致）。
// 已登记差异：Number("0x…") 十六进制 C# 端不支持（TryParse Float 样式），已登记差异。
namespace Taprint.PrintDsl
{
    /// <summary>表达式文法错误（携带记号位置；对应 TS ExpressionSyntaxError）。</summary>
    public sealed class ExpressionSyntaxError : Exception
    {
        /// <summary>出错位置（字符下标；-1 表示无具体位置）。</summary>
        public int Position { get; }

        /// <summary>构造：message + 出错位置（-1 表示无具体位置）。</summary>
        public ExpressionSyntaxError(string message, int position)
            : base(message)
        {
            Position = position;
        }
    }

    /// <summary>
    /// 表达式编译器：compile（≤1KB、嵌套 ≤64、白名单文法）+ evaluate（白名单操作符/过滤器、超时即抛）
    /// + extractFields（字段联动校验）。自定义函数由宿主以 Delegate 注入 data。
    /// </summary>
    public static class ExpressionCompiler
    {
        /// <summary>沙箱限额（主文档 ）。</summary>
        public const int MaxExprBytes = 1024;

        /// <summary>AST 最大嵌套深度。</summary>
        public const int MaxAstDepth = 64;

        /// <summary>表达式 → AST（沙箱限额：≤1KB、嵌套 ≤64；非法文法抛 ExpressionSyntaxError）。</summary>
        public static ExpressionAst Compile(string expr)
        {
            if (expr is null) throw new ArgumentNullException(nameof(expr), "表达式必须是字符串");
            if (Encoding.UTF8.GetByteCount(expr) > MaxExprBytes)
            {
                throw new ExpressionSyntaxError("表达式超出沙箱限额（1KB）", -1);
            }
            var root = new ParserState(Tokenize(expr)).Parse();
            CheckDepth(root, 1);
            return new ExpressionAst(expr, root);
        }

        /// <summary>
        /// AST → 求值（沙箱：白名单操作符/过滤器、超时即抛 TimeoutException）。
        /// 自定义函数由宿主以 Delegate 值注入 data。
        /// </summary>
        public static object? Evaluate(ExpressionAst ast, IReadOnlyDictionary<string, object?>? data, double timeout)
        {
            if (ast is null || ast.Root is null)
            {
                throw new ArgumentException("evaluate 需要 compile 产出的 AST", nameof(ast));
            }
            if (double.IsNaN(timeout) || double.IsInfinity(timeout) || timeout <= 0)
            {
                throw new ArgumentException("timeout 必须为正数（毫秒）", nameof(timeout));
            }
            var ctx = new EvalCtx(data ?? EmptyData, NowMs() + timeout, 0);
            return EvalNode(ast.Root, ctx);
        }

        /// <summary>列出表达式引用的字段路径（数字索引以点段表示；去重保序）。</summary>
        public static IReadOnlyList<string> ExtractFields(ExpressionAst ast)
        {
            var outList = new List<string>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            WalkFields(ast.Root, outList, seen);
            return outList;
        }

        private static readonly IReadOnlyDictionary<string, object?> EmptyData =
            new Dictionary<string, object?>();

        // ---------- 记号化 ----------

        private enum TokenKind { Num, Str, Ident, Punct }

        private sealed class Token
        {
            public TokenKind Kind;
            public object Value = null!; // double | string
            public int Pos;
        }

        private static readonly string[] Punct =
        {
            "===", "!==", "==", "!=", "<=", ">=", "&&", "||",
            "<", ">", "+", "-", "*", "/", "%", "!", "?", ":",
            "(", ")", "[", "]", ".", ",", "|",
        };

        /// <summary>
        /// 字符串转义白名单（二轮多语言实现同构必须逐字复现，未列出的转义编译期即拒）。
        /// </summary>
        private static readonly Dictionary<string, string> StringEscapes = new Dictionary<string, string>
        {
            ["n"] = "\n",
            ["t"] = "\t",
            ["r"] = "\r",
            ["\\"] = "\\",
            ["'"] = "'",
            ["\""] = "\"",
        };

        private static readonly Regex NumRe = new Regex(@"\G\d+(\.\d+)?", RegexOptions.Compiled);
        private static readonly Regex IdentRe = new Regex(@"\G[A-Za-z_$][A-Za-z0-9_$]*", RegexOptions.Compiled);

        private static List<Token> Tokenize(string src)
        {
            var tokens = new List<Token>();
            var i = 0;
            while (i < src.Length)
            {
                var ch = src[i];
                if (ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r')
                {
                    i++;
                    continue;
                }
                if (ch >= '0' && ch <= '9')
                {
                    var m = NumRe.Match(src, i);
                    tokens.Add(new Token
                    {
                        Kind = TokenKind.Num,
                        Value = double.Parse(m.Value, CultureInfo.InvariantCulture),
                        Pos = i,
                    });
                    i += m.Length;
                    continue;
                }
                if (ch == '\'' || ch == '"')
                {
                    var quote = ch;
                    var sb = new StringBuilder();
                    var j = i + 1;
                    var closed = false;
                    while (j < src.Length)
                    {
                        if (src[j] == '\\' && j + 1 < src.Length)
                        {
                            if (!StringEscapes.TryGetValue(src.Substring(j + 1, 1), out var mapped))
                            {
                                throw new ExpressionSyntaxError($"未知转义序列：\\{src[j + 1]}", i);
                            }
                            sb.Append(mapped);
                            j += 2;
                            continue;
                        }
                        if (src[j] == quote)
                        {
                            closed = true;
                            break;
                        }
                        sb.Append(src[j]);
                        j++;
                    }
                    if (!closed) throw new ExpressionSyntaxError("字符串未闭合", i);
                    tokens.Add(new Token { Kind = TokenKind.Str, Value = sb.ToString(), Pos = i });
                    i = j + 1;
                    continue;
                }
                if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch == '_' || ch == '$')
                {
                    var m = IdentRe.Match(src, i);
                    tokens.Add(new Token { Kind = TokenKind.Ident, Value = m.Value, Pos = i });
                    i += m.Length;
                    continue;
                }
                var punct = Punct.FirstOrDefault(p =>
                    i + p.Length <= src.Length && string.CompareOrdinal(src, i, p, 0, p.Length) == 0);
                if (punct != null)
                {
                    tokens.Add(new Token { Kind = TokenKind.Punct, Value = punct, Pos = i });
                    i += punct.Length;
                    continue;
                }
                throw new ExpressionSyntaxError($"非法字符：{ch}", i);
            }
            return tokens;
        }

        // ---------- 过滤器契约 ----------

        /// <summary>内置过滤器白名单（主文档  + default/avg/min/max；未知过滤器编译期即拒）。</summary>
        private static readonly HashSet<string> Filters = new HashSet<string>(StringComparer.Ordinal)
        {
            "date", "currency", "round", "sum", "avg", "min", "max",
            "count", "truncate", "mask", "default",
        };

        /// <summary>
        /// 过滤器参数编译期类型契约。空数组 = 不允许参数；'any' = 不限类型。
        /// </summary>
        private static readonly Dictionary<string, string[]> FilterArgRules = new Dictionary<string, string[]>
        {
            ["date"] = new[] { "string?" },
            ["currency"] = new[] { "string?" },
            ["round"] = new[] { "number?" },
            ["sum"] = new[] { "string?" },
            ["avg"] = new[] { "string?" },
            ["min"] = new[] { "string?" },
            ["max"] = new[] { "string?" },
            ["count"] = Array.Empty<string>(),
            ["truncate"] = new[] { "number?" },
            ["mask"] = new[] { "string?" },
            ["default"] = new[] { "any?" },
        };

        /// <summary>date 格式合法占位符。</summary>
        private static readonly string[] DateTokens = { "YYYY", "MM", "DD", "HH", "mm", "ss" };

        private static readonly Regex LetterRunRe = new Regex(@"^[A-Za-z]+", RegexOptions.Compiled);

        private static void CheckDateFormat(string fmt, int pos)
        {
            var i = 0;
            while (i < fmt.Length)
            {
                var tok = DateTokens.FirstOrDefault(t =>
                    i + t.Length <= fmt.Length && string.CompareOrdinal(fmt, i, t, 0, t.Length) == 0);
                if (tok != null)
                {
                    i += tok.Length;
                    continue;
                }
                if (IsAsciiLetter(fmt[i]))
                {
                    var run = LetterRunRe.Match(fmt.Substring(i)).Value;
                    throw new ExpressionSyntaxError(
                        $"date 格式含未识别占位符 \"{run}\"（合法占位符：YYYY/MM/DD/HH/mm/ss，大小写敏感）",
                        pos);
                }
                i++;
            }
        }

        /// <summary>ASCII 字母判定（镜像 TS /[A-Za-z]/；char.IsLetter 会误伤 CJK「年月日」）。</summary>
        private static bool IsAsciiLetter(char c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');

        // ---------- 递归下降解析 ----------

        private sealed class ParserState
        {
            private readonly List<Token> _tokens;
            private int _i;

            public ParserState(List<Token> tokens) => _tokens = tokens;

            public ExpressionNode Parse()
            {
                var node = ParseFilters();
                if (_i < _tokens.Count)
                {
                    throw new ExpressionSyntaxError("表达式存在未消费的记号", _tokens[_i].Pos);
                }
                return node;
            }

            private Token? Peek() => _i < _tokens.Count ? _tokens[_i] : null;

            private bool IsPunct(string value)
            {
                var t = Peek();
                return t != null && t.Kind == TokenKind.Punct && (string)t.Value == value;
            }

            private bool EatPunct(string value)
            {
                if (IsPunct(value))
                {
                    _i++;
                    return true;
                }
                return false;
            }

            private void ExpectPunct(string value)
            {
                if (!EatPunct(value))
                {
                    var t = Peek();
                    throw new ExpressionSyntaxError($"缺少 \"{value}\"", t?.Pos ?? -1);
                }
            }

            /// <summary>过滤管道绑定最松：expr | name:arg1:arg2</summary>
            private ExpressionNode ParseFilters()
            {
                var node = ParseTernary();
                while (EatPunct("|"))
                {
                    var nameTok = Peek();
                    if (nameTok == null || nameTok.Kind != TokenKind.Ident)
                    {
                        throw new ExpressionSyntaxError("过滤器名必须是标识符", nameTok?.Pos ?? -1);
                    }
                    _i++;
                    var name = (string)nameTok.Value;
                    if (!Filters.Contains(name))
                    {
                        throw new ExpressionSyntaxError($"未知过滤器：{name}", nameTok.Pos);
                    }
                    var args = new List<ExpressionNode>();
                    while (EatPunct(":"))
                    {
                        var arg = Peek();
                        //  示例 {{ amount | currency:CNY }}：裸标识符参数按字符串字面量处理
                        // 
                        if (arg == null ||
                            (arg.Kind != TokenKind.Str && arg.Kind != TokenKind.Num && arg.Kind != TokenKind.Ident))
                        {
                            throw new ExpressionSyntaxError(
                                "过滤器参数必须是字符串/数字/裸标识符字面量", arg?.Pos ?? -1);
                        }
                        _i++;
                        args.Add(new LiteralNode(arg.Value));
                    }
                    var rule = FilterArgRules.TryGetValue(name, out var r) ? r : Array.Empty<string>();
                    if (args.Count > rule.Length)
                    {
                        throw new ExpressionSyntaxError(
                            $"过滤器 {name} 最多接受 {rule.Length} 个参数", nameTok.Pos);
                    }
                    for (var idx = 0; idx < args.Count; idx++)
                    {
                        var expect = rule[idx].TrimEnd('?');
                        if (expect == "any") continue;
                        var value = ((LiteralNode)args[idx]).Value;
                        if (expect == "string" && !(value is string))
                        {
                            throw new ExpressionSyntaxError(
                                $"过滤器 {name} 第 {idx + 1} 个参数必须是字符串", nameTok.Pos);
                        }
                        if (expect == "number" && !(value is double))
                        {
                            throw new ExpressionSyntaxError(
                                $"过滤器 {name} 第 {idx + 1} 个参数必须是数字", nameTok.Pos);
                        }
                    }
                    if (name == "date" && args.Count > 0)
                    {
                        CheckDateFormat((string)((LiteralNode)args[0]).Value!, nameTok.Pos);
                    }
                    node = new FilterNode(node, name, args);
                }
                return node;
            }

            private ExpressionNode ParseTernary()
            {
                var test = ParseBinary(0);
                if (EatPunct("?"))
                {
                    var consequent = ParseTernary();
                    ExpectPunct(":");
                    var alternate = ParseTernary();
                    return new TernaryNode(test, consequent, alternate);
                }
                return test;
            }

            private static readonly string[][] Precedence =
            {
                new[] { "||" },
                new[] { "&&" },
                new[] { "==", "!=", "===", "!==" },
                new[] { "<", "<=", ">", ">=" },
                new[] { "+", "-" },
                new[] { "*", "/", "%" },
            };

            private ExpressionNode ParseBinary(int level)
            {
                if (level >= Precedence.Length) return ParseUnary();
                var left = ParseBinary(level + 1);
                var ops = Precedence[level];
                for (;;)
                {
                    var t = Peek();
                    if (t != null && t.Kind == TokenKind.Punct && Array.IndexOf(ops, (string)t.Value) >= 0)
                    {
                        _i++;
                        var right = ParseBinary(level + 1);
                        left = new BinaryNode((string)t.Value, left, right);
                        continue;
                    }
                    return left;
                }
            }

            private ExpressionNode ParseUnary()
            {
                var t = Peek();
                if (t != null && t.Kind == TokenKind.Punct &&
                    ((string)t.Value == "-" || (string)t.Value == "+" || (string)t.Value == "!"))
                {
                    _i++;
                    return new UnaryNode((string)t.Value, ParseUnary());
                }
                return ParsePostfix();
            }

            private ExpressionNode ParsePostfix()
            {
                var node = ParsePrimary();
                for (;;)
                {
                    if (EatPunct("."))
                    {
                        var t = Peek();
                        if (t == null || t.Kind != TokenKind.Ident)
                        {
                            throw new ExpressionSyntaxError("\".\" 后必须是标识符", t?.Pos ?? -1);
                        }
                        _i++;
                        node = AppendSegment(node, (string)t.Value);
                        continue;
                    }
                    if (EatPunct("["))
                    {
                        var t = Peek();
                        if (t == null || t.Kind != TokenKind.Num ||
                            !IsInteger((double)t.Value))
                        {
                            throw new ExpressionSyntaxError(
                                "索引仅支持非负整数（通配符 [*] 不参与表达式文法）", t?.Pos ?? -1);
                        }
                        _i++;
                        ExpectPunct("]");
                        node = AppendSegment(node, (int)(double)t.Value);
                        continue;
                    }
                    return node;
                }
            }

            /// <summary>path 追加段；非 path 节点（如函数返回值）不允许继续取成员。</summary>
            private static ExpressionNode AppendSegment(ExpressionNode node, object seg)
            {
                if (!(node is PathNode path))
                {
                    throw new ExpressionSyntaxError("仅字段路径支持成员/索引访问", -1);
                }
                var segments = new List<object>(path.Segments) { seg };
                return new PathNode(segments);
            }

            private ExpressionNode ParsePrimary()
            {
                var t = Peek();
                if (t == null) throw new ExpressionSyntaxError("表达式意外结束", -1);
                if (t.Kind == TokenKind.Num || t.Kind == TokenKind.Str)
                {
                    _i++;
                    return new LiteralNode(t.Value);
                }
                if (t.Kind == TokenKind.Punct && (string)t.Value == "(")
                {
                    _i++;
                    var node = ParseFilters();
                    ExpectPunct(")");
                    return node;
                }
                if (t.Kind == TokenKind.Ident)
                {
                    _i++;
                    var name = (string)t.Value;
                    if (name == "true" || name == "false") return new LiteralNode(name == "true");
                    if (name == "null") return new LiteralNode(null);
                    if (IsPunct("("))
                    {
                        _i++;
                        var args = new List<ExpressionNode>();
                        if (!IsPunct(")"))
                        {
                            for (;;)
                            {
                                args.Add(ParseTernary());
                                if (EatPunct(",")) continue;
                                break;
                            }
                        }
                        ExpectPunct(")");
                        return new CallNode(name, args);
                    }
                    return new PathNode(new List<object> { name });
                }
                throw new ExpressionSyntaxError("意外的记号", t.Pos);
            }

            private static bool IsInteger(double v) => !double.IsNaN(v) && !double.IsInfinity(v) && v == Math.Truncate(v);
        }

        private static void CheckDepth(ExpressionNode node, int depth)
        {
            if (depth > MaxAstDepth) throw new ExpressionSyntaxError("表达式嵌套过深", -1);
            switch (node)
            {
                case UnaryNode u:
                    CheckDepth(u.Operand, depth + 1);
                    break;
                case BinaryNode b:
                    CheckDepth(b.Left, depth + 1);
                    CheckDepth(b.Right, depth + 1);
                    break;
                case TernaryNode t:
                    CheckDepth(t.Test, depth + 1);
                    CheckDepth(t.Consequent, depth + 1);
                    CheckDepth(t.Alternate, depth + 1);
                    break;
                case FilterNode f:
                    CheckDepth(f.Value, depth + 1);
                    break;
                case CallNode c:
                    foreach (var a in c.Args) CheckDepth(a, depth + 1);
                    break;
            }
        }

        // ---------- 求值 ----------

        private sealed class EvalCtx
        {
            public readonly IReadOnlyDictionary<string, object?> Data;
            public readonly double Deadline;
            public long Ticks;

            public EvalCtx(IReadOnlyDictionary<string, object?> data, double deadline, long ticks)
            {
                Data = data;
                Deadline = deadline;
                Ticks = ticks;
            }
        }

        private static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        private static void Tick(EvalCtx ctx)
        {
            if (++ctx.Ticks % 128 == 0 && NowMs() > ctx.Deadline)
            {
                throw new TimeoutException("表达式求值超时（沙箱限额）");
            }
        }

        /// <summary>BCL 数字类型归一 double（宿主可能注入 int/decimal 等；JSON 数据面本就全 double）。</summary>
        private static bool TryGetDouble(object? v, out double d)
        {
            switch (v)
            {
                case double dd: d = dd; return true;
                case float f: d = f; return true;
                case int i: d = i; return true;
                case long l: d = l; return true;
                case short s: d = s; return true;
                case byte b: d = b; return true;
                case decimal m: d = (double)m; return true;
                default: d = 0; return false;
            }
        }

        /// <summary>JS truthy 判定。</summary>
        private static bool IsTruthy(object? v)
        {
            switch (v)
            {
                case null:
                case JsUndefined:
                    return false;
                case bool b: return b;
                case string s: return s.Length > 0;
                default:
                    return !TryGetDouble(v, out var d) || (d != 0 && !double.IsNaN(d));
            }
        }

        private static object? ResolvePath(IReadOnlyList<object> segments, IReadOnlyDictionary<string, object?> data)
        {
            object? cur = data;
            foreach (var seg in segments)
            {
                if (cur is null || cur is JsUndefined) return JsUndefined.Value;
                // 原型链防护（二轮）：仅读自有键——.NET 字典/列表天然仅自有成员，
                // constructor/__proto__ 等 JS 继承成员在 C# 侧不可达（多语言实现同口径）。
                // 自有访问复刻 JS Object.hasOwn(cur, seg)：字典数字段按键串 "0" 命中；
                // 列表的 length 为自有属性；非整数字符串段对列表不可达。
                if (cur is IDictionary<string, object?> dict)
                {
                    var key = seg is int i ? i.ToString(CultureInfo.InvariantCulture) : seg as string;
                    if (key == null || !dict.TryGetValue(key, out var next)) return JsUndefined.Value;
                    cur = next;
                    continue;
                }
                if (cur is IList list)
                {
                    if (seg is string s)
                    {
                        if (s == "length") { cur = (double)list.Count; continue; }
                        if (!int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var si)) return JsUndefined.Value;
                        if (si < 0 || si >= list.Count) return JsUndefined.Value;
                        cur = NormalizeHostValue(list[si]);
                        continue;
                    }
                    if (seg is int idx && idx >= 0 && idx < list.Count)
                    {
                        cur = NormalizeHostValue(list[idx]);
                        continue;
                    }
                    return JsUndefined.Value;
                }
                return JsUndefined.Value;
            }
            return cur;
        }

        /// <summary>宿主泛型列表（List&lt;double&gt; 等）元素归一——与 TryGetDouble 数字归一口径一致。</summary>
        private static object? NormalizeHostValue(object? v) => TryGetDouble(v, out var d) ? (object?)d : v;

        /// <summary>JS Number(string) 语义：trim 后空串 = 0；不支持十六进制（登记差异）。</summary>
        private static double NumberFromString(string s)
        {
            var t = s.Trim();
            if (t.Length == 0) return 0;
            return double.TryParse(t, NumberStyles.Float, CultureInfo.InvariantCulture, out var d)
                ? d
                : double.NaN;
        }

        /// <summary>
        /// TS toNumber 复刻：注意 '' → NaN（trim 守卫），与 NumberFromString('') = 0 的
        /// JS Number 口径分离——两处在 TS 源码中即为不同实现，C# 保持一致。
        /// </summary>
        private static double ToNumber(object? v)
        {
            if (TryGetDouble(v, out var num)) return num;
            if (v is string s)
            {
                if (s.Trim().Length > 0)
                {
                    var n = NumberFromString(s);
                    if (!double.IsNaN(n)) return n;
                }
            }
            if (v is bool b) return b ? 1 : 0;
            if (v is null) return 0;
            return double.NaN;
        }

        /// <summary>JS 严格相等（===）：类型+值；NaN !== NaN；+0 === -0；undefined 仅与自身相等；对象按引用。</summary>
        private static bool StrictEquals(object? a, object? b)
        {
            if (a is JsUndefined && b is JsUndefined) return true;
            if (a is JsUndefined || b is JsUndefined) return false;
            if (a is null && b is null) return true;
            if (a is null || b is null) return false;
            if (TryGetDouble(a, out var da) && TryGetDouble(b, out var db)) return da == db;
            if (TryGetDouble(a, out _) || TryGetDouble(b, out _)) return false;
            if (a is string sa && b is string sb) return string.Equals(sa, sb, StringComparison.Ordinal);
            if (a is bool ba && b is bool bb) return ba == bb;
            if (a is string || a is bool || b is string || b is bool) return false;
            return ReferenceEquals(a, b);
        }

        /// <summary>
        /// 宽松相等（== 语义，boolean 先转数字；number×string 走 JS Number）。
        /// 口径为 TS-loose（忠实复刻 TS 源）：null/undefined 不互转、对象不做 ToPrimitive——
        /// 与真实 JS ==（null==undefined 为 true、[] == 0 为 true）有意分叉，两端一致；
        /// 消费方不得以 x == null 判缺失（缺失路径为 JsUndefined，== null 恒 false）。已登记 。
        /// </summary>
        private static bool LooseEquals(object? a, object? b)
        {
            if (a is bool ba) return LooseEquals(ba ? 1.0 : 0.0, b);
            if (b is bool bb) return LooseEquals(a, bb ? 1.0 : 0.0);
            if (StrictEquals(a, b)) return true;
            if (TryGetDouble(a, out var da) && b is string sb) return da == NumberFromString(sb);
            if (TryGetDouble(b, out var db) && a is string sa) return db == NumberFromString(sa);
            return false;
        }

        /// <summary>JS 抽象关系比较：双字符串 Ordinal 字典序；否则双侧 ToNumber（NaN 一律 false）。</summary>
        private static bool Relational(object? l, object? r, string op)
        {
            int cmp;
            if (l is string sl && r is string sr)
            {
                cmp = string.CompareOrdinal(sl, sr);
            }
            else
            {
                var a = ToNumber(l);
                var b = ToNumber(r);
                if (double.IsNaN(a) || double.IsNaN(b)) return false;
                cmp = a.CompareTo(b);
            }
            switch (op)
            {
                case "<": return cmp < 0;
                case "<=": return cmp <= 0;
                case ">": return cmp > 0;
                default: return cmp >= 0;
            }
        }

        /// <summary>JS String(v)（拼接语义）：数字经 EcmaNumber.Format；数组逗号连接；对象 [object Object]。</summary>
        private static string JsString(object? v)
        {
            switch (v)
            {
                case null: return "null";
                case JsUndefined: return "undefined";
                case string s: return s;
                case bool b: return b ? "true" : "false";
                case IList list:
                    // 非泛型 IList：宿主注入 List<double>/List<string> 等同样走数组逗号连接
                    return string.Join(",", list.Cast<object?>().Select(item =>
                        item is null || item is JsUndefined ? "" : JsString(item)));
                case Delegate fn:
                    return $"function {fn.Method.Name}() {{ [native code] }}";
                default:
                    if (TryGetDouble(v, out var d))
                    {
                        if (double.IsNaN(d)) return "NaN";
                        if (double.IsPositiveInfinity(d)) return "Infinity";
                        if (double.IsNegativeInfinity(d)) return "-Infinity";
                        return EcmaNumber.Format(d);
                    }
                    return "[object Object]";
            }
        }

        private static object? EvalNode(ExpressionNode node, EvalCtx ctx)
        {
            Tick(ctx);
            switch (node)
            {
                case LiteralNode lit:
                    return lit.Value;
                case PathNode path:
                    return ResolvePath(path.Segments, ctx.Data);
                case UnaryNode u:
                {
                    var v = EvalNode(u.Operand, ctx);
                    if (u.Op == "!") return !IsTruthy(v);
                    return u.Op == "-" ? -ToNumber(v) : ToNumber(v);
                }
                case BinaryNode bin:
                    return EvalBinary(bin, ctx);
                case TernaryNode t:
                    return EvalNode(IsTruthy(EvalNode(t.Test, ctx)) ? t.Consequent : t.Alternate, ctx);
                case FilterNode f:
                    return ApplyFilter(f, ctx);
                case CallNode call:
                {
                    // 原型链防护（同 ResolvePath）：仅自有键注入的 Delegate 可调用
                    var fn = ctx.Data.TryGetValue(call.Name, out var v) ? v : null;
                    if (!(fn is Delegate del))
                    {
                        throw new InvalidOperationException(
                            $"未注册函数：{call.Name}（自定义函数须由宿主注入求值上下文）");
                    }
                    var args = call.Args.Select(a => EvalNode(a, ctx)).ToArray();
                    return del.DynamicInvoke(args);
                }
                default:
                    throw new InvalidOperationException("未知 AST 节点");
            }
        }

        private static object? EvalBinary(BinaryNode node, EvalCtx ctx)
        {
            if (node.Op == "&&")
            {
                var l = EvalNode(node.Left, ctx);
                return IsTruthy(l) ? EvalNode(node.Right, ctx) : l;
            }
            if (node.Op == "||")
            {
                var l = EvalNode(node.Left, ctx);
                return IsTruthy(l) ? l : EvalNode(node.Right, ctx);
            }
            var lv = EvalNode(node.Left, ctx);
            var rv = EvalNode(node.Right, ctx);
            switch (node.Op)
            {
                case "===": return StrictEquals(lv, rv);
                case "!==": return !StrictEquals(lv, rv);
                case "==": return LooseEquals(lv, rv);
                case "!=": return !LooseEquals(lv, rv);
                case "<":
                case "<=":
                case ">":
                case ">=":
                    return Relational(lv, rv, node.Op);
                case "+":
                    if (lv is string || rv is string)
                    {
                        // TS：`${l ?? ''}${r ?? ''}` —— null/undefined → 空串
                        return (lv is null || lv is JsUndefined ? "" : JsString(lv)) +
                               (rv is null || rv is JsUndefined ? "" : JsString(rv));
                    }
                    return ToNumber(lv) + ToNumber(rv);
                case "-": return ToNumber(lv) - ToNumber(rv);
                case "*": return ToNumber(lv) * ToNumber(rv);
                case "/": return ToNumber(lv) / ToNumber(rv);
                case "%": return ToNumber(lv) % ToNumber(rv);
                default:
                    throw new InvalidOperationException($"未知操作符：{node.Op}");
            }
        }

        // ---------- 过滤器（主文档  七例 + default/avg/min/max） ----------

        private static readonly Dictionary<string, string> CurrencySymbol = new Dictionary<string, string>
        {
            ["CNY"] = "¥",
            ["USD"] = "$",
            ["EUR"] = "€",
            ["GBP"] = "£",
            ["JPY"] = "JP¥",
            ["HKD"] = "HK$",
            ["KRW"] = "₩",
            ["TWD"] = "NT$",
        };

        /// <summary>
        /// JS Number.prototype.toFixed 复刻：ties 远离零（(−0.5).toFixed(0)="-1"，Node 实测基线）；
        /// |x| ≥ 1e21 回退 EcmaNumber.Format（JS 同行为）。实现为精确有理数算术
        /// （IEEE-754 分解 x = m×2^e2，与 10^f 通分后整除），避免任何浮点/decimal 精度回归。
        /// </summary>
        internal static string ToFixed(double x, int f)
        {
            if (double.IsNaN(x)) return "NaN";
            if (double.IsPositiveInfinity(x)) return "Infinity";
            if (double.IsNegativeInfinity(x)) return "-Infinity";
            if (Math.Abs(x) >= 1e21) return EcmaNumber.Format(x);
            var negative = x < 0;
            var bits = (ulong)BitConverter.DoubleToInt64Bits(Math.Abs(x));
            var mantissa = (System.Numerics.BigInteger)(bits & 0xF_FFFF_FFFF_FFFFL);
            var exp = (int)((bits >> 52) & 0x7FF);
            if (exp == 0)
            {
                exp = -1074; // 次正规数：value = mantissa × 2^-1074
            }
            else
            {
                mantissa += System.Numerics.BigInteger.One << 52;
                exp -= 1075;
            }
            System.Numerics.BigInteger numerator, denominator;
            var e10 = System.Numerics.BigInteger.Pow(10, f);
            if (exp >= 0)
            {
                numerator = mantissa * (System.Numerics.BigInteger.One << exp) * e10;
                denominator = System.Numerics.BigInteger.One;
            }
            else
            {
                numerator = mantissa * e10;
                denominator = System.Numerics.BigInteger.One << (-exp);
            }
            var rounded = (numerator * 2 + denominator) / (2 * denominator); // ties 远离零
            var digits = rounded.ToString(CultureInfo.InvariantCulture);
            if (f == 0) return (negative ? "-" : "") + digits;
            if (digits.Length <= f) digits = digits.PadLeft(f + 1, '0');
            var intPart = digits.Substring(0, digits.Length - f);
            var frac = digits.Substring(digits.Length - f);
            return (negative ? "-" : "") + intPart + "." + frac;
        }

        /// <summary>JS Math.round 复刻：Floor(x + 0.5)；Math.round(-0.5) = -0（C# 银行家舍入禁用）。</summary>
        internal static double JsRound(double x)
        {
            if (double.IsNaN(x)) return double.NaN;
            if (double.IsInfinity(x)) return x;
            var f = Math.Floor(x + 0.5);
            if (f == 0 && x < 0) return -0.0;
            return f;
        }

        private static string FormatNumber(double v, int digits)
        {
            var fixedStr = ToFixed(v, digits);
            var parts = fixedStr.Split('.');
            var intPart = parts[0];
            var frac = parts.Length > 1 ? parts[1] : null;
            var negative = intPart.StartsWith("-", StringComparison.Ordinal);
            var digitsOnly = negative ? intPart.Substring(1) : intPart;
            var grouped = Regex.Replace(digitsOnly, @"\B(?=(\d{3})+(?!\d))", ",");
            return (negative ? "-" : "") + grouped + (frac != null ? "." + frac : "");
        }

        // V8 接受面：月/日允许 1-2 位（"2026-1-1" 合法，V8 真值），
        // 时/分/秒/时区保持 2 位补零（V8 ISO 严格），时区代码层校验放宽至 ±23:59（V8 实测）。
        private static readonly Regex IsoDateRe = new Regex(
            @"^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|z|[+-]\d{2}:?\d{2})?)?$",
            RegexOptions.Compiled);

        /// <summary>
        /// JS new Date(v) 语义：数字 = unix ms；
        /// 字符串接受 V8 ISO 8601 子集（见 ParseJsIso）。V8 遗留格式（MM/DD/YYYY、月名、裸时间等）
        /// 不支持 → null → ''。Scope 0.1 放宽五类 V8 合法 ISO 边缘输入（非补零月日、24:00 进位、
        /// 时区 ±23:59、date-only 首尾空白、年 0），TS↔C# 分叉消除。
        /// 数值分支与 TS toDate 逐字一致：NaN/Infinity/超 ±8.64e15 范围 → JsDate.Invalid
        /// （V8 Invalid Date，FormatDate 输出 "NaN" 占位；不得返 null→''——''仅字符串解析失败），
        /// 且 (long) 强转前必须先过范围守卫（1e300 unchecked 溢出成垃圾值，）。
        /// 内部返回 JsDate（long UtcMs）以支持 proleptic Gregorian 年 0，绕过 DateTimeOffset 最小年 1 限制。
        /// 字段访问按 V8 语义：getFullYear 等用「系统本地时区」（FormatDate 内 LocalOffsetMinutes）。
        /// </summary>
        private static JsDate? ToDate(object? v)
        {
            if (TryGetDouble(v, out var ms))
            {
                if (double.IsNaN(ms) || double.IsInfinity(ms)) return JsDate.Invalid;
                // V8 合法 ms 范围 ±8.64e15（Node 实测：8640000000000000 合法、8640000000000001 Invalid）
                if (ms > 8.64e15 || ms < -8.64e15) return JsDate.Invalid;
                return new JsDate((long)ms);
            }
            return v is string s ? ParseJsIso(s) : null;
        }

        /// <summary>
        /// V8 ISO 8601 子集：
        ///  - 月/日允许非补零（"2026-1-1" 合法）
        ///  - hour=24 且分秒毫秒全 0 进位到次日零点（"2026-01-01T24:00" → 次日）
        ///  - 时区偏移放宽至 ±23:59（V8 实测 +23:59/-23:59 合法）
        ///  - 首尾空白：date-only / 空格分隔形态宽容（V8 真值），T 分隔形态严格拒绝
        ///  - year=0 支持 proleptic Gregorian（JsDate.FromLocal 不依赖 DateTime 构造）
        ///  - day>当月天数自动进位（JsDate.WithAddedDays，V8 同语义）
        /// offset 语义：date-only → 按 UTC（offset=0）；date+time 无时区 → 本地；
        /// Z → UTC；±HH:mm → 该偏移。JsDate 仅存 UtcMs（offset 不保留），字段访问走系统本地时区（V8 语义）。
        /// </summary>
        private static JsDate? ParseJsIso(string raw)
        {
            // V8 真值：含 T/t 分隔符的 ISO 严格（首尾空白拒绝）；date-only / 空格分隔形态宽容（trim 后解析）
            var s = raw;
            if (raw.IndexOf('T') < 0 && raw.IndexOf('t') < 0)
            {
                s = raw.Trim();
            }
            var m = IsoDateRe.Match(s);
            if (!m.Success) return null;
            var year = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
            var month = m.Groups[2].Success ? int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture) : 1;
            var day = m.Groups[3].Success ? int.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture) : 1;
            if (month < 1 || month > 12 || day < 1) return null;
            if (!m.Groups[4].Success)
            {
                // date-only → 按 UTC 存储（offset=0）；day>当月天数时进位（V8 同语义）
                var baseDate = JsDate.FromLocal(year, month, 1, 0, 0, 0, 0, 0);
                return baseDate.WithAddedDays(day - 1);
            }
            var hour = int.Parse(m.Groups[4].Value, CultureInfo.InvariantCulture);
            var minute = int.Parse(m.Groups[5].Value, CultureInfo.InvariantCulture);
            var second = m.Groups[6].Success ? int.Parse(m.Groups[6].Value, CultureInfo.InvariantCulture) : 0;
            if (minute > 59 || second > 59) return null;
            var millis = 0;
            if (m.Groups[7].Success)
            {
                var frac = m.Groups[7].Value;
                millis = int.Parse((frac + "000").Substring(0, 3), CultureInfo.InvariantCulture);
            }
            // hour=24 V8 真值：仅当分/秒/毫秒全 0 时进位到次日零点，否则拒绝
            if (hour == 24)
            {
                if (minute != 0 || second != 0 || millis != 0) return null;
                hour = 0;
                day = day + 1;
            }
            else if (hour > 24)
            {
                return null;
            }
            // 时区解析：date+time 无时区 → 本地 offset；Z → 0；±HH:mm → 该偏移
            var zone = m.Groups[8].Value;
            short offsetMinutes;
            if (zone.Length == 0) offsetMinutes = LocalOffsetMinutes();
            else if (zone == "Z" || zone == "z") offsetMinutes = 0;
            else
            {
                var sign = zone[0] == '-' ? -1 : 1;
                var zoneBody = zone.Substring(1).Replace(":", "");
                var zh = int.Parse(zoneBody.Substring(0, 2), CultureInfo.InvariantCulture);
                var zm = int.Parse(zoneBody.Substring(2, 2), CultureInfo.InvariantCulture);
                // V8 真值：时区偏移上限 ±23:59（Node v22.22.2 实测，原 ±14:00 过严）
                if (zh > 23 || zm > 59) return null;
                offsetMinutes = (short)(sign * (zh * 60 + zm));
            }
            // 用 day=1 + WithAddedDays(day-1) 处理 day>当月天数进位（与 V8 DateTime.AddDays 同语义，
            // 但 JsDate 用 Hinnant 算法支持 year=0）
            var baseDt = JsDate.FromLocal(year, month, 1, hour, minute, second, millis, offsetMinutes);
            return baseDt.WithAddedDays(day - 1);
        }

        private static string FormatDate(JsDate d, string fmt)
        {
            // V8 Invalid Date（数值 ms 超范围）：getFullYear/getMonth 等全 NaN，
            // String(NaN)="NaN"、padStart 对 3 字符 "NaN" 不补 → 各占位符均输出 "NaN"（TS formatDate 逐字一致）
            if (!d.IsValid)
            {
                return fmt
                    .Replace("YYYY", "NaN").Replace("MM", "NaN").Replace("DD", "NaN")
                    .Replace("HH", "NaN").Replace("mm", "NaN").Replace("ss", "NaN");
            }
            // V8 语义：getFullYear 等用「系统本地时区」（TZ=UTC 即 UTC），与输入自带 offset 无关
            d.DeconstructLocal(LocalOffsetMinutes(), out var year, out var month, out var day, out var hour, out var minute, out var second, out _);
            // 与 TS formatDate 逐字对齐：YYYY 占位符按 V8 String(getFullYear()) 实际位数输出
            // （year=0 → "0"，不补零；year>=1000 自然 4 位）。padStart 仅在 MM/DD/HH/mm/ss。
            return fmt
                .Replace("YYYY", year.ToString(CultureInfo.InvariantCulture))
                .Replace("MM", month.ToString("00", CultureInfo.InvariantCulture))
                .Replace("DD", day.ToString("00", CultureInfo.InvariantCulture))
                .Replace("HH", hour.ToString("00", CultureInfo.InvariantCulture))
                .Replace("mm", minute.ToString("00", CultureInfo.InvariantCulture))
                .Replace("ss", second.ToString("00", CultureInfo.InvariantCulture));
        }

        /// <summary>系统本地时区偏移（分钟）。TZ=UTC 为 0；TZ=UTC+8 为 480。DST 不考虑（与 V8 BaseUtcOffset 同口径）。</summary>
        private static short LocalOffsetMinutes() => (short)TimeZoneInfo.Local.BaseUtcOffset.TotalMinutes;

        private static object? ApplyFilter(FilterNode node, EvalCtx ctx)
        {
            var v = EvalNode(node.Value, ctx);
            var args = node.Args.Select(a => EvalNode(a, ctx)).ToList();
            switch (node.Name)
            {
                case "date":
                {
                    var d = ToDate(v);
                    if (d is null) return "";
                    return FormatDate(d.Value, args.Count > 0 && args[0] is string fmt ? fmt : "YYYY-MM-DD");
                }
                case "currency":
                {
                    var n = ToNumber(v);
                    if (double.IsNaN(n)) return "";
                    if (args.Count > 0 && !(args[0] is string))
                    {
                        throw new InvalidOperationException("currency 过滤器参数必须是币种代码字符串（编译期已校，此为防御分支）");
                    }
                    var code = args.Count > 0 ? (string)args[0]! : "CNY";
                    var symbol = CurrencySymbol.TryGetValue(code, out var s) ? s : code + " ";
                    return symbol + FormatNumber(n, 2);
                }
                case "round":
                {
                    var n = ToNumber(v);
                    if (double.IsNaN(n)) return "";
                    var digits = args.Count > 0 && TryGetDouble(args[0], out var dd) ? dd : 0;
                    var factor = Math.Pow(10, digits);
                    return JsRound(n * factor) / factor;
                }
                case "sum":
                {
                    if (!(v is IList list)) return "";
                    var field = args.Count > 0 && args[0] is string f ? f : null;
                    double acc = 0;
                    foreach (var item in list)
                    {
                        var raw = field != null ? ReadField(item, field) : item;
                        var n = ToNumber(raw);
                        acc += double.IsNaN(n) ? 0 : n;
                    }
                    return acc;
                }
                case "avg":
                case "min":
                case "max":
                {
                    if (!(v is IList list)) return "";
                    var field = args.Count > 0 && args[0] is string f ? f : null;
                    var nums = new List<double>();
                    foreach (var item in list)
                    {
                        var raw = field != null ? ReadField(item, field) : item;
                        var n = ToNumber(raw);
                        if (!double.IsNaN(n)) nums.Add(n);
                    }
                    if (nums.Count == 0) return "";
                    if (node.Name == "avg") return nums.Sum() / nums.Count;
                    return node.Name == "min" ? nums.Min() : nums.Max();
                }
                case "count":
                    if (v is IList l) return (double)l.Count;
                    if (v is string str) return (double)str.Length;
                    return 0.0;
                case "truncate":
                {
                    var s = v is null || v is JsUndefined ? "" : JsString(v);
                    var max = args.Count > 0 && TryGetDouble(args[0], out var m) ? m : 20;
                    if (s.Length <= max) return s; // 含 max=3e9（钳制返回全串）；NaN 不成立走下面
                    // JS slice(0, max) 钳制语义：负数按长度相对取，NaN→0；
                    // 此处 max < s.Length，截断值必在 int 域内，无溢出
                    var t = Math.Truncate(max);
                    int end;
                    if (double.IsNaN(t)) end = 0;
                    else if (t >= 0) end = (int)t;
                    else end = Math.Max(s.Length + (int)Math.Max(t, -s.Length), 0);
                    return s.Substring(0, end) + "...";
                }
                case "mask":
                {
                    // pattern 定义掩码版式：'*' 位输出 '*'，其余位透传原文同位字符（不足取 pattern 字符）
                    var s = v is null || v is JsUndefined ? "" : JsString(v);
                    var pattern = args.Count > 0 && args[0] is string p ? p : new string('*', s.Length);
                    var sb = new StringBuilder(pattern.Length);
                    for (var i = 0; i < pattern.Length; i++)
                    {
                        var c = pattern[i];
                        sb.Append(c == '*' ? '*' : (i < s.Length ? s[i] : c));
                    }
                    return sb.ToString();
                }
                case "default":
                {
                    var fallback = args.Count > 0 ? args[0] : null;
                    if (v is null || v is JsUndefined || (v is string es && es.Length == 0)) return fallback ?? "";
                    return v;
                }
                default:
                    throw new InvalidOperationException($"未知过滤器：{node.Name}");
            }
        }

        // ope 0.2：泛型 IDictionary<string,object?> 优先（带类型化 TryGetValue），
        // 回退非泛型 IDictionary 收 Dictionary<string,double>/Dictionary<string,int> 等强类型字典
        // （修复 List<Dictionary<string,double>> 上 sum:'amount' 返 0 的 TS↔C# 分叉，TS 实测为 12.5）。
        private static object? ReadField(object? item, string field)
        {
            if (item is IDictionary<string, object?> dictGen && dictGen.TryGetValue(field, out var v)) return v;
            if (item is IDictionary dictNonGen && dictNonGen.Contains(field)) return dictNonGen[field];
            return JsUndefined.Value;
        }

        private static void WalkFields(ExpressionNode node, List<string> outList, HashSet<string> seen)
        {
            switch (node)
            {
                case PathNode path:
                    var joined = string.Join(".", path.Segments.Select(seg =>
                        seg is int i ? i.ToString(CultureInfo.InvariantCulture) : (string)seg));
                    if (seen.Add(joined)) outList.Add(joined);
                    break;
                case UnaryNode u:
                    WalkFields(u.Operand, outList, seen);
                    break;
                case BinaryNode b:
                    WalkFields(b.Left, outList, seen);
                    WalkFields(b.Right, outList, seen);
                    break;
                case TernaryNode t:
                    WalkFields(t.Test, outList, seen);
                    WalkFields(t.Consequent, outList, seen);
                    WalkFields(t.Alternate, outList, seen);
                    break;
                case FilterNode f:
                    WalkFields(f.Value, outList, seen);
                    break;
                case CallNode c:
                    foreach (var a in c.Args) WalkFields(a, outList, seen);
                    break;
            }
        }
    }
}
