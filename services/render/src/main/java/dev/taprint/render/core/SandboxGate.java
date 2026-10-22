/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.render.core;

import dev.taprint.expression.ExpressionAudit;
import dev.taprint.expression.HostFunctions;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Service-side gate in front of the kernel sandbox (ADR-0012: AST allowlist —
 * literals, pure functions, property access only).
 *
 * <p>Layering, outermost first:</p>
 * <ol>
 *   <li>this gate — function-call whitelist via the kernel's own
 *       {@link ExpressionAudit} (unknown and host functions are rejected
 *       explicitly), plus a lexical deny list inside {@code {{ ... }}}
 *       placeholders for statement-shaped input the kernel evaluates without
 *       error: {@code import} declarations, {@code new} expressions,
 *       multi-statement {@code ;}, QL static-access {@code @} syntax and
 *       assignments;</li>
 *   <li>the kernel sandbox itself — QLExpress4 {@code StrategyIsolation},
 *       which blocks member-method calls, constructors and static access at
 *       evaluation time.</li>
 * </ol>
 *
 * <p>The gate never decides by itself what the kernel allows: the AST
 * whitelist authority is the kernel's existing implementation; this class only
 * front-loads deterministic rejections.</p>
 */
public final class SandboxGate {

    private static final Pattern PLACEHOLDER = Pattern.compile("\\{\\{(.*?)\\}\\}", Pattern.DOTALL);

    private static final Pattern DENY_IMPORT = Pattern.compile("\\bimport\\b");
    private static final Pattern DENY_NEW = Pattern.compile("\\bnew\\b");
    private static final Pattern DENY_STATEMENT = Pattern.compile(";");
    private static final Pattern DENY_STATIC_ACCESS = Pattern.compile("@");
    /** Assignment {@code =} that is not {@code ==}, {@code !=}, {@code <=}, {@code >=}. */
    private static final Pattern DENY_ASSIGNMENT =
            Pattern.compile("(?<![=!<>+\\-*/%&|^])=(?!=)");

    private SandboxGate() {
    }

    /**
     * @param templateJson raw template DSL JSON (placeholders are scanned
     *                     inside it; surrounding literal text is untouched)
     * @return violations, empty when the template passes the gate
     */
    public static List<String> scan(String templateJson) {
        List<String> violations = new ArrayList<>();
        if (templateJson == null || templateJson.isEmpty()) {
            return violations;
        }
        for (String err : ExpressionAudit.audit(templateJson, HostFunctions.EMPTY)) {
            violations.add(err);
        }
        Matcher m = PLACEHOLDER.matcher(templateJson);
        while (m.find()) {
            String expr = m.group(1);
            if (DENY_IMPORT.matcher(expr).find()) {
                violations.add("import statements are not allowed in expressions: {{" + trim(expr) + "}}");
            }
            if (DENY_NEW.matcher(expr).find()) {
                violations.add("constructor expressions (new) are not allowed in expressions: {{" + trim(expr) + "}}");
            }
            if (DENY_STATEMENT.matcher(expr).find()) {
                violations.add("multi-statement expressions are not allowed: {{" + trim(expr) + "}}");
            }
            if (DENY_STATIC_ACCESS.matcher(expr).find()) {
                violations.add("static-access syntax is not allowed in expressions: {{" + trim(expr) + "}}");
            }
            if (DENY_ASSIGNMENT.matcher(expr).find()) {
                violations.add("assignments are not allowed in expressions: {{" + trim(expr) + "}}");
            }
        }
        return violations;
    }

    private static String trim(String expr) {
        String t = expr.trim();
        return t.length() > 80 ? t.substring(0, 80) + "…" : t;
    }
}
