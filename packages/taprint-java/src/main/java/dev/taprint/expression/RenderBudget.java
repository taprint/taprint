/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.expression;

import dev.taprint.core.PrintKernelException;
import dev.taprint.core.PrintErrorCode;

/**
  * Per-render resource budget.
 * <p>每次 eval() 新建一个实例：表达式总耗时 ≤5s、#each 累计迭代 ≤100k
 * （嵌套循环共享同一计数器），防大模板绕过 30s 渲染超时。
 */
public class RenderBudget {

    private final long deadlineNanos;
    private final long maxIterations;
    private long consumedIterations;

    public RenderBudget(long totalBudgetMs, long maxIterations) {
        this.deadlineNanos = System.nanoTime() + totalBudgetMs * 1_000_000L;
        this.maxIterations = maxIterations;
    }

    /** 表达式总耗时预算检查（每个表达式求值前调用） */
    public void checkElapsed() {
        if (System.nanoTime() > deadlineNanos) {
            throw PrintKernelException.builder()
                    .errorCode(PrintErrorCode.RENDER_BUDGET_EXCEEDED)
                    .build();
        }
    }

    /** 每次循环迭代前扣减（嵌套 each 共享计数器） */
    public void consumeIteration() {
        if (++consumedIterations > maxIterations) {
            throw PrintKernelException.builder()
                    .errorCode(PrintErrorCode.LOOP_BUDGET_EXCEEDED)
                    .build();
        }
    }

    public long getConsumedIterations() {
        return consumedIterations;
    }
}
