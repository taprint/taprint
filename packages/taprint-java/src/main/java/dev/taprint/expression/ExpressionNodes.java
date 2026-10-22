/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.expression;

import java.util.List;

/**
  * Expression AST nodes.
 * <p>kind 对应关系：literal/path/unary/binary/ternary/filter/call。
 */
public abstract class ExpressionNodes {

    private ExpressionNodes() {
    }

    public abstract static class ExpressionNode {
        private int depth;

        public int getDepth() {
            return depth;
        }

        public void setDepth(int depth) {
            this.depth = depth;
        }
    }

    /** 字面量：number/string/boolean/null */
    public static class LiteralNode extends ExpressionNode {
        public final Object value;

        public LiteralNode(Object value) {
            this.value = value;
        }
    }

    /** 字段/变量引用：segments = 标识符与整数索引混排（items.0.sku ⇔ items[0].sku） */
    public static class PathNode extends ExpressionNode {
        public final List<Object> segments;

        public PathNode(List<Object> segments) {
            this.segments = segments;
        }
    }

    public static class UnaryNode extends ExpressionNode {
        public final String op;
        public final ExpressionNode operand;

        public UnaryNode(String op, ExpressionNode operand) {
            this.op = op;
            this.operand = operand;
        }
    }

    public static class BinaryNode extends ExpressionNode {
        public final String op;
        public final ExpressionNode left;
        public final ExpressionNode right;

        public BinaryNode(String op, ExpressionNode left, ExpressionNode right) {
            this.op = op;
            this.left = left;
            this.right = right;
        }
    }

    public static class TernaryNode extends ExpressionNode {
        public final ExpressionNode test;
        public final ExpressionNode consequent;
        public final ExpressionNode alternate;

        public TernaryNode(ExpressionNode test, ExpressionNode consequent, ExpressionNode alternate) {
            this.test = test;
            this.consequent = consequent;
            this.alternate = alternate;
        }
    }

    /** Liquid 过滤管道：value | name:arg1:arg2（参数为字面量） */
    public static class FilterNode extends ExpressionNode {
        public final ExpressionNode value;
        public final String name;
        public final List<ExpressionNode> args;

        public FilterNode(ExpressionNode value, String name, List<ExpressionNode> args) {
            this.value = value;
            this.name = name;
            this.args = args;
        }
    }

    /** 自定义函数调用：now()/uuid()/tenantName() 等 */
    public static class CallNode extends ExpressionNode {
        public final String name;
        public final List<ExpressionNode> args;

        public CallNode(String name, List<ExpressionNode> args) {
            this.name = name;
            this.args = args;
        }
    }
}
