/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.core;

import lombok.Data;

/**
 * Tunable limits of the expression sandbox and evaluator.
 *
 * <p>Plain data holder: the kernel is framework-free, so hosts construct and
 * pass it explicitly (see {@code Taprint}). Defaults match the documented
 * sandbox contract: 100ms per expression, 5s total budget, 100k loop
 * iterations, 1MB templates, 1KB expressions, if-nesting 5, each-nesting 3.</p>
 */
@Data
public class KernelOptions {

    private Expression expression = new Expression();

    @Data
    public static class Expression {
        /** Per-expression evaluation timeout */
        private long evalTimeoutMs = 100;
        /** Total expression time budget for one render */
        private long renderBudgetMs = 5000;
        /** Maximum template DSL size in bytes */
        private int templateMaxBytes = 1048576;
        /** Maximum single expression size in bytes */
        private int exprMaxBytes = 1024;
        /** Maximum {@code #if} block nesting */
        private int blockNestDepth = 5;
        /** Maximum {@code #each} block nesting */
        private int eachNestDepth = 3;
        /** Maximum cumulative loop iterations per render */
        private long eachLoopTotalLimit = 100000;
    }
}
