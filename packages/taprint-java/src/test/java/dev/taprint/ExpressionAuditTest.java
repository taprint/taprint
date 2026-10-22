/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint;

import dev.taprint.expression.ExpressionAudit;
import dev.taprint.expression.HostFunctions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertFalse;

import dev.taprint.core.PrintErrorCode;
import dev.taprint.core.PrintKernelException;

/**
 * Static-audit behavior of the host-functions SPI (ADR-0007): unregistered
 * function calls are detected at validation time, registered ones pass, and
 * kernel builtins always pass.
 */
class ExpressionAuditTest {

    @Test
    @DisplayName("builtin and filter calls pass without a host registry")
    void test_builtinsPass() {
        assertTrue(ExpressionAudit.audit("{{ upper(name) }}", HostFunctions.EMPTY).isEmpty());
        assertTrue(ExpressionAudit.audit("{{ total | currency:'CNY' }}", HostFunctions.EMPTY).isEmpty());
        assertTrue(ExpressionAudit.audit("{{ now() }}", null).isEmpty());
        assertTrue(ExpressionAudit.audit("plain text without placeholders", HostFunctions.EMPTY).isEmpty());
    }

    @Test
    @DisplayName("unregistered business functions are detected statically")
    void test_unknownFunctionReported() {
        List<String> errors = ExpressionAudit.audit(
                "tenant of {{ tenantName() }} at {{ storeName() }}", HostFunctions.EMPTY);
        assertEquals(2, errors.size());
        assertTrue(errors.get(0).contains("tenantName"));
        assertTrue(errors.get(1).contains("storeName"));
    }

    @Test
    @DisplayName("functions declared by the host registry pass the audit")
    void test_registeredHostFunctionPasses() {
        HostFunctions registry = new HostFunctions() {
            @Override
            public boolean isRegistered(String name) {
                return "shopName".equals(name);
            }

            @Override
            public Object invoke(String name, List<Object> args) {
                return "demo";
            }

            @Override
            public List<String> declaredNames() {
                return List.of("shopName");
            }
        };
        assertTrue(ExpressionAudit.audit("{{ shopName() }}", registry).isEmpty());
        assertFalse(ExpressionAudit.audit("{{ otherHostFn() }}", registry).isEmpty());
    }

    @Test
    @DisplayName("requireKnownFunctions throws EXPRESSION_INVALID on the first unknown call")
    void test_throwingVariant() {
        PrintKernelException e = assertThrows(PrintKernelException.class,
                () -> ExpressionAudit.requireKnownFunctions("{{ storeName() }}", HostFunctions.EMPTY));
        assertEquals(PrintErrorCode.EXPRESSION_INVALID, e.getErrorCode());
        assertTrue(e.getMessage().contains("storeName"));
    }

    @Test
    @DisplayName("evaluation-time failure for an unregistered host function is explicit")
    void test_evaluationTimeFailure() {
        PrintKernelException e = assertThrows(PrintKernelException.class,
                () -> ExpressionAudit.requireKnownFunctions("{{ nope() }}", HostFunctions.EMPTY));
        assertTrue(e.getMessage().contains("HostFunctions SPI") || e.getMessage().contains("nope"));
    }
}
