/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.expression;

import dev.taprint.core.PrintErrorCode;
import dev.taprint.core.PrintKernelException;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Static audit of template expressions against the callable-function
 * whitelist (ADR-0007): kernel builtins plus the names declared by the
 * {@link HostFunctions} registry. Any other function call is reported so
 * hosts can reject such templates at validation time, before any rendering;
 * at evaluation time the same call fails explicitly inside the engine.
 *
 * <p>Call-syntax check only: names followed by {@code (} inside
 * {@code {{ ... }}} are audited; filters are validated against the filter
 * whitelist by {@link ExpressionParser} itself.</p>
 */
public final class ExpressionAudit {

    private static final Pattern PLACEHOLDER = Pattern.compile("\\{\\{(.*?)\\}\\}", Pattern.DOTALL);
    private static final Pattern CALL = Pattern.compile("([A-Za-z_\\$@][A-Za-z0-9_\\$]*)\\s*\\(");

    private ExpressionAudit() {
    }

    /** Builtin function names callable in every kernel (no host registry needed). */
    public static Set<String> builtinNames() {
        return new HashSet<>(QLExpress4Engine.builtinFunctionNames());
    }

    /**
     * Collect function-call errors from one template string (any text that may
     * contain {@code {{ ... }}} placeholders).
     *
     * @param template      template text; null/empty yields no errors
     * @param hostFunctions host registry whose declared names are callable
     * @return error messages, empty when every called function is whitelisted
     */
    public static List<String> audit(String template, HostFunctions hostFunctions) {
        List<String> errors = new ArrayList<>();
        if (template == null || template.indexOf("{{") < 0) {
            return errors;
        }
        Set<String> allowed = builtinNames();
        if (hostFunctions != null) {
            allowed.addAll(hostFunctions.declaredNames());
        }
        Matcher m = PLACEHOLDER.matcher(template);
        while (m.find()) {
            String expr = m.group(1);
            Matcher calls = CALL.matcher(expr);
            while (calls.find()) {
                String name = calls.group(1);
                if (!allowed.contains(name)) {
                    errors.add("unknown function '" + name + "()' in {{"
                            + expr.trim() + "}} - not a kernel builtin and not registered"
                            + " via the HostFunctions SPI");
                }
            }
        }
        return errors;
    }

    /**
     * Throwing variant used by validators: raises on the first unknown call.
     *
     * @throws PrintKernelException with {@link PrintErrorCode#EXPRESSION_INVALID}
     */
    public static void requireKnownFunctions(String template, HostFunctions hostFunctions) {
        List<String> errors = audit(template, hostFunctions);
        if (!errors.isEmpty()) {
            throw PrintKernelException.of(PrintErrorCode.EXPRESSION_INVALID, errors.get(0));
        }
    }
}
