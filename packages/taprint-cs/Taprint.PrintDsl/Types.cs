// SPDX-License-Identifier: Apache-2.0
using System.Collections.Generic;

// 表达式 AST 类型（对应 print-dsl-ts types.ts ExpressionNode 判别联合； v1.41 锁定：
// 多语言实现同结构指 kind/字段语义同构，C# 以抽象基类 + sealed record 子类表达判别联合）。
namespace Taprint.PrintDsl
{
    /// <summary>表达式 AST 节点基类（kind 由具体子类型表达）。</summary>
    public abstract record ExpressionNode;

    /// <summary>字面量：number(string 内 double)/string/bool/null。</summary>
    public sealed record LiteralNode(object? Value) : ExpressionNode;

    /// <summary>字段/变量引用：segments = 标识符(string) 与整数索引(int) 混排（items.0.sku ⇔ items[0].sku）。</summary>
    public sealed record PathNode(IReadOnlyList<object> Segments) : ExpressionNode;

    /// <summary>一元运算：op ∈ { '-', '+', '!' }。</summary>
    public sealed record UnaryNode(string Op, ExpressionNode Operand) : ExpressionNode;

    /// <summary>二元运算：op ∈ { ||, &amp;&amp;, ===, !==, ==, !=, &lt;, &lt;=, &gt;, &gt;=, +, -, *, /, % }。</summary>
    public sealed record BinaryNode(string Op, ExpressionNode Left, ExpressionNode Right) : ExpressionNode;

    /// <summary>三元条件：test ? consequent : alternate。</summary>
    public sealed record TernaryNode(ExpressionNode Test, ExpressionNode Consequent, ExpressionNode Alternate) : ExpressionNode;

    /// <summary>Liquid 过滤管道：value | name:arg1:arg2（参数为字面量节点）。</summary>
    public sealed record FilterNode(ExpressionNode Value, string Name, IReadOnlyList<ExpressionNode> Args) : ExpressionNode;

    /// <summary>自定义函数调用（now()/uuid()/tenantName() 等；求值上下文注入 Delegate）。</summary>
    public sealed record CallNode(string Name, IReadOnlyList<ExpressionNode> Args) : ExpressionNode;

    /// <summary>
    /// JS undefined 语义哨兵：路径缺失/索引越界求值结果。C# 无 undefined，而 TS 端
    /// 严格区分 null 与 undefined（如缺失字段 `a == null` 为 false、`undefined === undefined`
    /// 为 true），多语言实现一致要求显式建模（不进 JSON 数据面，仅表达式求值域内流转）。
    /// </summary>
    public sealed class JsUndefined
    {
        /// <summary>唯一实例。</summary>
        public static readonly JsUndefined Value = new JsUndefined();

        private JsUndefined()
        {
        }

        /// <inheritdoc />
        public override string ToString() => "undefined";
    }

    /// <summary>表达式 AST（ExpressionCompiler.Compile 产物）。</summary>
    public sealed record ExpressionAst
    {
        /// <summary>原始表达式文本（不含 {{ }}）。</summary>
        public string Raw { get; }

        /// <summary>语法树根。</summary>
        public ExpressionNode Root { get; }

        internal ExpressionAst(string raw, ExpressionNode root)
        {
            Raw = raw;
            Root = root;
        }
    }
}
