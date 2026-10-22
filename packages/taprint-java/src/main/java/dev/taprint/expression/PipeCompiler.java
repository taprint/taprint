/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.expression;

import dev.taprint.expression.ExpressionNodes.BinaryNode;
import dev.taprint.expression.ExpressionNodes.CallNode;
import dev.taprint.expression.ExpressionNodes.ExpressionNode;
import dev.taprint.expression.ExpressionNodes.FilterNode;
import dev.taprint.expression.ExpressionNodes.LiteralNode;
import dev.taprint.expression.ExpressionNodes.PathNode;
import dev.taprint.expression.ExpressionNodes.TernaryNode;
import dev.taprint.expression.ExpressionNodes.UnaryNode;

import java.math.BigDecimal;

/**
 * 前编译为函数调用 {@code f(a, 'x')}（QLExpress4 无原生 | 操作符）。
 *
 * 重新生成为 QL 语法串；同时完成两项适配：
 * <ul>
 *   <li>{@code ===}/{@code !==}（JS 严格相等）→ {@code ==}/{@code !=}（QL 无此操作符）</li>
 *   <li>{@code @} 前缀循环变量（@item/@index）→ 合法 QL 标识符别名（__at_*）</li>
 * </ul>
 */
public class PipeCompiler {

    /** 循环变量 @name → QL 合法标识符 */
    public static String sanitizeIdent(String name) {
        if (name != null && name.startsWith("@")) {
            return "__at_" + name.substring(1);
        }
        return name;
    }

    public static String compile(String expr) {
        ExpressionNode ast = ExpressionParser.parse(expr);
        StringBuilder sb = new StringBuilder();
        emit(ast, sb);
        return sb.toString();
    }

    private static void emit(ExpressionNode node, StringBuilder sb) {
        if (node instanceof LiteralNode) {
            emitLiteral((LiteralNode) node, sb);
        } else if (node instanceof PathNode) {
            emitPath((PathNode) node, sb);
        } else if (node instanceof UnaryNode) {
            UnaryNode un = (UnaryNode) node;
            if ("+".equals(un.op)) {
                emit(un.operand, sb);
            } else {
                sb.append(un.op).append(' ');
                sb.append('(');
                emit(un.operand, sb);
                sb.append(')');
            }
        } else if (node instanceof BinaryNode) {
            BinaryNode bn = (BinaryNode) node;
            String op = bn.op;
            if ("===".equals(op)) {
                op = "==";
            } else if ("!==".equals(op)) {
                op = "!=";
            }
            sb.append('(');
            emit(bn.left, sb);
            sb.append(' ').append(op).append(' ');
            emit(bn.right, sb);
            sb.append(')');
        } else if (node instanceof TernaryNode) {
            TernaryNode tn = (TernaryNode) node;
            sb.append('(');
            emit(tn.test, sb);
            sb.append(" ? ");
            emit(tn.consequent, sb);
            sb.append(" : ");
            emit(tn.alternate, sb);
            sb.append(')');
        } else if (node instanceof FilterNode) {
            FilterNode fn = (FilterNode) node;
            sb.append(fn.name).append('(');
            emit(fn.value, sb);
            for (ExpressionNode arg : fn.args) {
                sb.append(", ");
                emit(arg, sb);
            }
            sb.append(')');
        } else if (node instanceof CallNode) {
            CallNode cn = (CallNode) node;
            sb.append(cn.name).append('(');
            for (int i = 0; i < cn.args.size(); i++) {
                if (i > 0) {
                    sb.append(", ");
                }
                emit(cn.args.get(i), sb);
            }
            sb.append(')');
        } else {
            throw new IllegalStateException("未知 AST 节点: " + node.getClass().getSimpleName());
        }
    }

    private static void emitLiteral(LiteralNode node, StringBuilder sb) {
        Object v = node.value;
        if (v == null) {
            sb.append("null");
        } else if (v instanceof String) {
            sb.append('\'');
            String s = (String) v;
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                if (c == '\'') {
                    sb.append("\\'");
                } else if (c == '\\') {
                    sb.append("\\\\");
                } else if (c == '\n') {
                    sb.append("\\n");
                } else if (c == '\r') {
                    sb.append("\\r");
                } else if (c == '\t') {
                    sb.append("\\t");
                } else {
                    sb.append(c);
                }
            }
            sb.append('\'');
        } else if (v instanceof BigDecimal) {
            sb.append(((BigDecimal) v).toPlainString());
        } else {
            sb.append(v);
        }
    }

    private static void emitPath(PathNode node, StringBuilder sb) {
        for (int i = 0; i < node.segments.size(); i++) {
            Object seg = node.segments.get(i);
            if (seg instanceof Integer) {
                sb.append('[').append(seg).append(']');
            } else {
                if (i > 0) {
                    sb.append('.');
                }
                sb.append(sanitizeIdent((String) seg));
            }
        }
    }
}
