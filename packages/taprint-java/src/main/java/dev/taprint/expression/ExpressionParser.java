/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.expression;

import dev.taprint.core.PrintKernelException;
import dev.taprint.core.PrintErrorCode;
import dev.taprint.expression.ExpressionNodes.BinaryNode;
import dev.taprint.expression.ExpressionNodes.CallNode;
import dev.taprint.expression.ExpressionNodes.ExpressionNode;
import dev.taprint.expression.ExpressionNodes.FilterNode;
import dev.taprint.expression.ExpressionNodes.LiteralNode;
import dev.taprint.expression.ExpressionNodes.PathNode;
import dev.taprint.expression.ExpressionNodes.TernaryNode;
import dev.taprint.expression.ExpressionNodes.UnaryNode;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
  * Recursive-descent expression parser.
 * <p>优先级（从低到高）：管道 | → 三元 ?: → || → && → 相等 → 关系 → 加减 → 乘除模 → 一元 → 后缀。
 * 过滤管道参数仅允许字面量（字符串/数字/裸标识符）。
 */
public class ExpressionParser {

    public static final Set<String> FILTERS = new HashSet<>(Arrays.asList(
            "date", "currency", "round", "sum", "avg", "min", "max",
            "count", "truncate", "mask", "default"));

    public static final int MAX_AST_DEPTH = 64;

    private final String src;
    private int pos;
    private int depth;

    public ExpressionParser(String src) {
        this.src = src == null ? "" : src;
        this.pos = 0;
        this.depth = 0;
    }

    public static ExpressionNode parse(String expr) {
        ExpressionParser parser = new ExpressionParser(expr);
        ExpressionNode node = parser.parsePipeline();
        parser.skipWhitespace();
        if (parser.pos < parser.src.length()) {
            throw parser.fail("表达式存在无法解析的尾部: '" + parser.src.substring(parser.pos) + "'");
        }
        return node;
    }

    private ExpressionNode parsePipeline() {
        ExpressionNode value = parseTernary();
        while (true) {
            skipWhitespace();
            if (peek() == '|') {
                pos++;
                skipWhitespace();
                String name = readIdentifier();
                if (name == null || !FILTERS.contains(name)) {
                    throw fail("未知过滤器: " + name);
                }
                List<ExpressionNode> args = new ArrayList<>();
                while (true) {
                    skipWhitespace();
                    if (peek() == ':') {
                        pos++;
                        args.add(parseFilterArg());
                    } else {
                        break;
                    }
                }
                value = track(new FilterNode(value, name, args));
            } else {
                break;
            }
        }
        return value;
    }

    /** 管道参数仅字面量：字符串 / 数字 / 裸标识符（按字符串字面量处理，如 currency:CNY） */
    private ExpressionNode parseFilterArg() {
        skipWhitespace();
        char c = peek();
        if (c == '\'' || c == '"') {
            return new LiteralNode(readString());
        }
        if (c == '-' || Character.isDigit(c)) {
            return new LiteralNode(readNumber());
        }
        String ident = readIdentifier();
        if (ident == null) {
            throw fail("过滤器参数必须是字面量");
        }
        return new LiteralNode(ident);
    }

    private ExpressionNode parseTernary() {
        ExpressionNode test = parseBinary(0);
        skipWhitespace();
        if (peek() == '?') {
            pos++;
            ExpressionNode consequent = parsePipeline();
            skipWhitespace();
            if (peek() != ':') {
                throw fail("三元表达式缺少 ':'");
            }
            pos++;
            ExpressionNode alternate = parsePipeline();
            return track(new TernaryNode(test, consequent, alternate));
        }
        return test;
    }

    private static final String[][] BINARY_LEVELS = {
            {"||"},
            {"&&"},
            {"===", "!==", "==", "!="},
            {"<=", ">=", "<", ">"},
            {"+", "-"},
            {"*", "/", "%"},
    };

    private ExpressionNode parseBinary(int level) {
        if (level >= BINARY_LEVELS.length) {
            return parseUnary();
        }
        ExpressionNode left = parseBinary(level + 1);
        while (true) {
            skipWhitespace();
            String op = matchOperator(BINARY_LEVELS[level]);
            if (op == null) {
                return left;
            }
            ExpressionNode right = parseBinary(level + 1);
            left = track(new BinaryNode(op, left, right));
        }
    }

    private String matchOperator(String[] ops) {
        for (String op : ops) {
            if (src.startsWith(op, pos)) {
                // '===' 与 '=='、'!==' 与 '!=' 需 longest-match（ops 已按长者优先排列）
                pos += op.length();
                return op;
            }
        }
        return null;
    }

    private ExpressionNode parseUnary() {
        skipWhitespace();
        char c = peek();
        if (c == '-' || c == '+' || c == '!') {
            pos++;
            return track(new UnaryNode(String.valueOf(c), parseUnary()));
        }
        return parsePostfix();
    }

    private ExpressionNode parsePostfix() {
        ExpressionNode node = parsePrimary();
        while (true) {
            skipWhitespace();
            char c = peek();
            if (c == '.') {
                pos++;
                List<Object> segs = flattenSegments(node);
                if (segs == null) {
                    throw fail("属性访问只能用于字段路径");
                }
                if (Character.isDigit(peek())) {
                    segs.add(readIndex());
                } else {
                    String ident = readIdentifier();
                    if (ident == null) {
                        throw fail("'.' 后必须是标识符或非负整数");
                    }
                    segs.add(ident);
                }
                node = new PathNode(segs);
            } else if (c == '[') {
                pos++;
                skipWhitespace();
                int index = readIndex();
                skipWhitespace();
                if (peek() != ']') {
                    throw fail("']' 缺失");
                }
                pos++;
                List<Object> segs = flattenSegments(node);
                if (segs == null) {
                    throw fail("下标访问只能用于字段路径");
                }
                segs.add(index);
                node = new PathNode(segs);
            } else {
                return node;
            }
        }
    }

    /** PathNode 追加段；首个段是标识符时从 PathNode/CallNode 起步 */
    private List<Object> flattenSegments(ExpressionNode node) {
        if (node instanceof PathNode) {
            return new ArrayList<>(((PathNode) node).segments);
        }
        if (node instanceof CallNode) {
            List<Object> segs = new ArrayList<>();
            segs.add(((CallNode) node).name);
            return segs;
        }
        return null;
    }

    private ExpressionNode parsePrimary() {
        skipWhitespace();
        char c = peek();
        if (c == 0) {
            throw fail("表达式意外结束");
        }
        if (c == '(') {
            pos++;
            ExpressionNode node = parsePipeline();
            skipWhitespace();
            if (peek() != ')') {
                throw fail("')' 缺失");
            }
            pos++;
            return node;
        }
        if (c == '\'' || c == '"') {
            return new LiteralNode(readString());
        }
        if (Character.isDigit(c)) {
            return new LiteralNode(readNumber());
        }
        String ident = readIdentifier();
        if (ident == null) {
            throw fail("无法识别的字符: '" + c + "'");
        }
        if ("true".equals(ident)) {
            return new LiteralNode(Boolean.TRUE);
        }
        if ("false".equals(ident)) {
            return new LiteralNode(Boolean.FALSE);
        }
        if ("null".equals(ident) || "undefined".equals(ident)) {
            return new LiteralNode(null);
        }
        skipWhitespace();
        if (peek() == '(') {
            pos++;
            List<ExpressionNode> args = new ArrayList<>();
            skipWhitespace();
            if (peek() != ')') {
                while (true) {
                    args.add(parsePipeline());
                    skipWhitespace();
                    if (peek() == ',') {
                        pos++;
                    } else {
                        break;
                    }
                }
            }
            if (peek() != ')') {
                throw fail("')' 缺失");
            }
            pos++;
            return track(new CallNode(ident, args));
        }
        List<Object> segs = new ArrayList<>();
        segs.add(ident);
        return new PathNode(segs);
    }

    private int readIndex() {
        skipWhitespace();
        int start = pos;
        while (pos < src.length() && Character.isDigit(src.charAt(pos))) {
            pos++;
        }
        if (start == pos) {
            throw fail("下标必须是非负整数");
        }
        return Integer.parseInt(src.substring(start, pos));
    }

    private String readIdentifier() {
        skipWhitespace();
        int start = pos;
        while (pos < src.length()) {
            char c = src.charAt(pos);
            if (Character.isLetterOrDigit(c) || c == '_' || c == '$' || c == '@') {
                pos++;
            } else {
                break;
            }
        }
        return start == pos ? null : src.substring(start, pos);
    }

    private String readString() {
        char quote = src.charAt(pos);
        pos++;
        StringBuilder sb = new StringBuilder();
        while (pos < src.length()) {
            char c = src.charAt(pos);
            if (c == '\\') {
                pos++;
                if (pos >= src.length()) {
                    throw fail("字符串转义意外结束");
                }
                char esc = src.charAt(pos);
                switch (esc) {
                    case 'n': sb.append('\n'); break;
                    case 't': sb.append('\t'); break;
                    case 'r': sb.append('\r'); break;
                    case '\\': sb.append('\\'); break;
                    case '\'': sb.append('\''); break;
                    case '"': sb.append('"'); break;
                    default:
                        throw fail("非法转义字符: \\" + esc);
                }
                pos++;
            } else if (c == quote) {
                pos++;
                return sb.toString();
            } else {
                sb.append(c);
                pos++;
            }
        }
        throw fail("字符串未闭合");
    }

    private Number readNumber() {
        int start = pos;
        if (peek() == '-') {
            pos++;
        }
        boolean dot = false;
        while (pos < src.length()) {
            char c = src.charAt(pos);
            if (Character.isDigit(c)) {
                pos++;
            } else if (c == '.' && !dot) {
                dot = true;
                pos++;
            } else {
                break;
            }
        }
        String num = src.substring(start, pos);
        if (num.isEmpty() || "-".equals(num) || ".".equals(num) || "-.".equals(num)) {
            throw fail("非法数字");
        }
        if (dot) {
            return Double.parseDouble(num);
        }
        long v = Long.parseLong(num);
        if (v >= Integer.MIN_VALUE && v <= Integer.MAX_VALUE) {
            return (int) v;
        }
        return v;
    }

    private char peek() {
        return pos < src.length() ? src.charAt(pos) : 0;
    }

    private void skipWhitespace() {
        while (pos < src.length() && Character.isWhitespace(src.charAt(pos))) {
            pos++;
        }
    }

    private <T extends ExpressionNode> T track(T node) {
        depth++;
        if (depth > MAX_AST_DEPTH) {
            throw fail("表达式嵌套深度超过 " + MAX_AST_DEPTH);
        }
        node.setDepth(depth);
        return node;
    }

    private PrintKernelException fail(String msg) {
        return PrintKernelException.builder()
                .errorCode(PrintErrorCode.EXPRESSION_INVALID)
                .message(msg + " | 表达式: " + src)
                .build();
    }
}
