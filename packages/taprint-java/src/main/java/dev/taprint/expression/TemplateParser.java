/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.expression;

import dev.taprint.core.PrintKernelException;
import dev.taprint.core.PrintErrorCode;
import dev.taprint.expression.TemplateAst.EachNode;
import dev.taprint.expression.TemplateAst.IfNode;
import dev.taprint.expression.TemplateAst.TemplateNode;
import dev.taprint.expression.TemplateAst.TextNode;

import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 模板字符串解析器：识别 {{...}} 插值与 {{#if}}/{{else}}/{{/if}}、{{#each}}/{{/each}} 块。
 *
 * <p>校验：块结构平衡、each 嵌套 ≤3 层、if 嵌套 ≤5 层（SandboxPolicy 限制）。
 */
public class TemplateParser {

    private static final Pattern TOKEN = Pattern.compile("\\{\\{(.+?)\\}\\}", Pattern.DOTALL);
    private static final Pattern EACH_HEADER = Pattern.compile("^#each\\s+(\\S+)(?:\\s+as\\s+(@?\\w+)(?:\\s*,\\s*(@?\\w+))?)?$");

    private final SandboxPolicy sandboxPolicy;

    public TemplateParser(SandboxPolicy sandboxPolicy) {
        this.sandboxPolicy = sandboxPolicy;
    }

    public TemplateAst parse(String template) {
        TemplateAst ast = new TemplateAst();
        if (template == null || template.isEmpty()) {
            return ast;
        }
        Matcher m = TOKEN.matcher(template);
        int last = 0;
        Frame root = new Frame(null, null, ast.getNodes(), 0, 0);
        Frame current = root;
        while (m.find()) {
            if (m.start() > last) {
                current.nodes.add(new TextNode(template.substring(last, m.start())));
            }
            String tag = m.group(1).trim();
            if (tag.startsWith("#if ")) {
                int ifDepth = current.ifDepth + 1;
                if (ifDepth > sandboxPolicy.getMaxIfNestDepth()) {
                    throw PrintKernelException.builder()
                            .errorCode(PrintErrorCode.BLOCK_DEPTH_EXCEEDED)
                            .message("{{#if}} 嵌套超过 " + sandboxPolicy.getMaxIfNestDepth() + " 层")
                            .build();
                }
                IfNode ifNode = new IfNode(tag.substring(4).trim());
                current.nodes.add(ifNode);
                Frame next = new Frame(current, "if", ifNode.getThenBranch(), ifDepth, current.eachDepth);
                next.ifNode = ifNode;
                current = next;
            } else if (tag.equals("else")) {
                if (current.ifNode == null) {
                    throw blockError("{{else}} 不在 {{#if}} 内");
                }
                IfNode owner = current.ifNode;
                List<TemplateNode> elseBranch = new java.util.ArrayList<>();
                owner.setElseBranch(elseBranch);
                Frame next = new Frame(current.parent, "if", elseBranch, current.ifDepth, current.eachDepth);
                next.ifNode = owner;
                current = next;
            } else if (tag.equals("/if")) {
                if (current.ifNode == null) {
                    throw blockError("{{/if}} 与 {{#if}} 不匹配");
                }
                current = current.parent;
            } else if (tag.startsWith("#each")) {
                Matcher em = EACH_HEADER.matcher(tag);
                if (!em.matches()) {
                    throw blockError("{{#each}} 语法错误: " + tag);
                }
                int eachDepth = current.eachDepth + 1;
                if (eachDepth > sandboxPolicy.getMaxEachNestDepth()) {
                    throw PrintKernelException.builder()
                            .errorCode(PrintErrorCode.BLOCK_DEPTH_EXCEEDED)
                            .message("{{#each}} 嵌套超过 " + sandboxPolicy.getMaxEachNestDepth() + " 层")
                            .build();
                }
                String itemName = em.group(2) != null ? em.group(2) : "@item";
                String indexName = em.group(3) != null ? em.group(3) : "@index";
                EachNode eachNode = new EachNode(em.group(1), itemName, indexName);
                current.nodes.add(eachNode);
                Frame next = new Frame(current, "each", eachNode.getBody(), current.ifDepth, eachDepth);
                next.eachNode = eachNode;
                current = next;
            } else if (tag.equals("/each")) {
                if (current.eachNode == null) {
                    throw blockError("{{/each}} 与 {{#each}} 不匹配");
                }
                current = current.parent;
            } else if (tag.startsWith("#")) {
                throw blockError("未知块语法: " + tag);
            } else {
                // 普通插值（含过滤管道），保留原始表达式文本
                current.nodes.add(new TextNode("{{" + tag + "}}"));
            }
            last = m.end();
        }
        if (last < template.length()) {
            current.nodes.add(new TextNode(template.substring(last)));
        }
        if (current != root) {
            throw blockError("块结构未闭合: 缺少 {{/" + current.kind + "}}");
        }
        return ast;
    }

    private PrintKernelException blockError(String msg) {
        return PrintKernelException.builder()
                .errorCode(PrintErrorCode.EXPRESSION_INVALID)
                .message(msg)
                .build();
    }

    /** 解析栈帧 */
    private static class Frame {
        final Frame parent;
        final String kind;
        final List<TemplateNode> nodes;
        final int ifDepth;
        final int eachDepth;
        IfNode ifNode;
        EachNode eachNode;

        Frame(Frame parent, String kind, List<TemplateNode> nodes, int ifDepth, int eachDepth) {
            this.parent = parent;
            this.kind = kind;
            this.nodes = nodes;
            this.ifDepth = ifDepth;
            this.eachDepth = eachDepth;
        }
    }
}
