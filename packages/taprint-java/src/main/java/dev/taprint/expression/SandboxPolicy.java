/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.expression;

import dev.taprint.core.PrintKernelException;
import dev.taprint.core.KernelOptions;
import dev.taprint.core.PrintErrorCode;

import java.nio.charset.StandardCharsets;

/**
  * Sandbox policy: length and depth pre-validation layer.
 * 超时与循环预算由 {@link RenderBudget} + QLOptions.timeoutMillis 承担。
 */
public class SandboxPolicy {

    private final KernelOptions properties;

    public SandboxPolicy(KernelOptions properties) {
        this.properties = properties;
    }

    /** 单表达式 ≤ 1KB（边界含） */
    public void validateExpression(String expr) {
        if (expr == null) {
            return;
        }
        if (expr.getBytes(StandardCharsets.UTF_8).length > properties.getExpression().getExprMaxBytes()) {
            throw PrintKernelException.builder()
                    .errorCode(PrintErrorCode.EXPRESSION_TOO_LONG)
                    .message("表达式长度 " + expr.length() + " 字符")
                    .build();
        }
    }

    /** 单 DSL ≤ 1MB */
    public void validateTemplate(String dslJson) {
        if (dslJson == null) {
            return;
        }
        if (dslJson.getBytes(StandardCharsets.UTF_8).length > properties.getExpression().getTemplateMaxBytes()) {
            throw PrintKernelException.builder()
                    .errorCode(PrintErrorCode.TEMPLATE_DSL_TOO_LARGE)
                    .build();
        }
    }

    public int getMaxEachNestDepth() {
        return properties.getExpression().getEachNestDepth();
    }

    public int getMaxIfNestDepth() {
        return properties.getExpression().getBlockNestDepth();
    }
}
