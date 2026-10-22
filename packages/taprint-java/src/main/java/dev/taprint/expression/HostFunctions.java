/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.expression;

import dev.taprint.core.PrintErrorCode;
import dev.taprint.core.PrintKernelException;

import java.util.List;

/**
 * Host-function SPI (ADR-0007): the extension point through which a host
 * application registers its own domain functions for template expressions.
 *
 * <p>The kernel registers no business functions itself. Functions registered
 * here become callable inside {@code {{ ... }}} expressions with zero or more
 * arguments. A template that calls a function which is neither a kernel
 * builtin nor registered through this SPI fails statically at validation time
 * (see {@link ExpressionAudit}) and explicitly at evaluation time.</p>
 *
 * <p>Implementations should be deterministic where possible: templates that
 * call host functions are excluded from byte-level cross-language goldens, so
 * parity across hosts is the adopter's contract.</p>
 */
public interface HostFunctions {

    /** Registry with no host functions (the kernel default). */
    HostFunctions EMPTY = new HostFunctions() {
        @Override
        public boolean isRegistered(String name) {
            return false;
        }

        @Override
        public Object invoke(String name, List<Object> args) {
            throw unregistered(name);
        }
    };

    /**
     * @param name function name as written in the template
     * @return true if the registry can serve this function
     */
    boolean isRegistered(String name);

    /**
     * Invoke a registered host function.
     *
     * @param name function name (only called when {@link #isRegistered} is true)
     * @param args evaluated argument values
     * @return function result; may be null
     */
    Object invoke(String name, List<Object> args);

    /**
     * Names of all registered host functions, used by the static template
     * audit ({@link ExpressionAudit}). Registries that cannot enumerate their
     * names leave the default: the audit then reports nothing and unknown
     * functions surface at evaluation time instead.
     *
     * @return registered function names; empty when not enumerable
     */
    default List<String> declaredNames() {
        return List.of();
    }

    /** Error raised when an unregistered host function is invoked. */
    static PrintKernelException unregistered(String name) {
        return PrintKernelException.of(PrintErrorCode.EXPRESSION_EVAL_FAILED,
                "Host function not registered: " + name + "()"
                        + " - register it via the HostFunctions SPI");
    }
}
