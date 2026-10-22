/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.core;

/**
 * Kernel error codes (expression sandbox and rendering layers).
 *
 * <p>Only the codes the rendering kernel itself can raise are listed here;
 * template storage, job orchestration and rate limiting stay in the host
 * application.</p>
 */
public enum PrintErrorCode {

    // 06 00 xxx - template
    TEMPLATE_DSL_INVALID      ("0600003", "print.template.dsl_invalid",       "Template DSL validation failed: {0}"),
    TEMPLATE_DSL_TOO_LARGE    ("0600004", "print.template.dsl_too_large",     "Template DSL exceeds the 1MB limit"),
    TEMPLATE_PRESENTATION_MISSING("0600006", "print.template.presentation_missing", "Template is missing the {0} presentation"),

    // 06 01 xxx - expression & sandbox
    EXPRESSION_INVALID        ("0601001", "print.expression.invalid",         "Invalid expression: {0}"),
    EXPRESSION_TOO_LONG       ("0601002", "print.expression.too_long",        "Single expression exceeds the 1KB limit"),
    EXPRESSION_TIMEOUT        ("0601003", "print.expression.timeout",         "Expression evaluation timed out: {0}"),
    EXPRESSION_EVAL_FAILED    ("0601004", "print.expression.eval_failed",     "Expression evaluation failed: {0}"),
    BLOCK_DEPTH_EXCEEDED      ("0601005", "print.expression.block_depth_exceeded", "Template block nesting exceeds the limit (each<=3/if<=5)"),
    LOOP_BUDGET_EXCEEDED      ("0601006", "print.expression.loop_budget_exceeded", "Cumulative loop iterations exceed the 100k limit"),
    RENDER_BUDGET_EXCEEDED    ("0601007", "print.expression.render_budget_exceeded", "Total expression time exceeds the 5s budget"),
    SANDBOX_VIOLATION         ("0601008", "print.expression.sandbox_violation", "Expression tripped the sandbox: {0}"),

    // 06 02 xxx - rendering
    RENDER_FAILED             ("0602001", "print.render.failed",              "Rendering failed: {0}"),
    UNSUPPORTED_DEVICE_CLASS  ("0602002", "print.render.unsupported_device_class", "Unsupported device class or missing presentation"),
    UNSUPPORTED_ELEMENT       ("0602003", "print.render.unsupported_element", "Unsupported template element: {0}"),
    RENDER_TIMEOUT            ("0602004", "print.render.timeout",             "Rendering timed out"),
    COMMAND_SET_MISMATCH      ("0602005", "print.render.command_set_mismatch", "Command set does not match the device class: {0}");

    private final String code;
    private final String messageKey;
    private final String defaultMessage;

    PrintErrorCode(String code, String messageKey, String defaultMessage) {
        this.code = code;
        this.messageKey = messageKey;
        this.defaultMessage = defaultMessage;
    }

    public String getCode() {
        return code;
    }

    public String getMessageKey() {
        return messageKey;
    }

    public String getDefaultMessage() {
        return defaultMessage;
    }
}
