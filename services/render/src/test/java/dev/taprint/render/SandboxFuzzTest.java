/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.render;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Sandbox fuzz corpus against the live HTTP surface. Every payload is a
 * template-as-code escape attempt — member-method calls, import statements,
 * static-access syntax, prototype-escape chains — and every one must be
 * rejected with an explicit 422 sandbox-violation, never executed
 * (ADR-0012: AST allowlist = literals, pure functions, property access only).
 *
 * <p>Kernel authority: the QLExpress4 StrategyIsolation sandbox rejects
 * member calls/static access at evaluation time; this suite pins that the
 * HTTP surface never returns 2xx for the whole corpus, including the shapes
 * the kernel itself front-rejects here (import statements would otherwise
 * evaluate to a harmless null — the service gate rejects them regardless).</p>
 */
@SpringBootTest
@AutoConfigureMockMvc
class SandboxFuzzTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Autowired
    private MockMvc mvc;

    static Stream<String> escapePayloads() {
        return Stream.of(
                // ---- member-method invocation ----
                "name.getClass().getName()",
                "\"\".getClass().getName()",
                "\"\".concat(Thread.currentThread().getName())",
                "\"\".class.forName(\"java.lang.Runtime\")",
                // ---- java.lang escapes ----
                "Runtime.getRuntime().exec(\"id\")",
                "System.exit(0)",
                "new java.io.File(\"/etc/passwd\").exists()",
                // ---- import / statement shapes ----
                "import java.lang.Runtime;",
                "import java.lang.Runtime; Runtime.getRuntime()",
                "x = 1",
                "1;System.exit(0)",
                // ---- static-access syntax ----
                "@java.lang.System@getProperty(\"user.dir\")",
                // ---- prototype-escape string variants ----
                "\"\".constructor.constructor(\"return 1\")()",
                "name.__proto__.constructor(\"x\")",
                "constructor.constructor(\"return 1\")()",
                // ---- dynamic evaluation / IIFE / unknown function ----
                "eval(\"1+1\")",
                "(function(){return 1})()",
                "unknownHostFn(1)");
    }

    private static String renderRequest(String payloadExpr) {
        ObjectNode template = JSON.createObjectNode();
        template.put("schemaVersion", "1.0");
        template.put("id", "fuzz_receipt");
        template.put("code", "FUZZ_RECEIPT");
        template.put("name", "fuzz receipt");
        ObjectNode receipt = template.putObject("presentations").putObject("receipt");
        receipt.put("width", "80mm");
        receipt.put("encoding", "gbk");
        ObjectNode text = receipt.putArray("body").addObject();
        text.put("type", "text");
        text.put("content", "{{" + payloadExpr + "}}");
        ObjectNode root = JSON.createObjectNode();
        root.set("template", template);
        root.put("target", "escpos");
        ObjectNode data = JSON.createObjectNode();
        data.put("name", "x");
        root.set("data", data);
        return root.toString();
    }

    @ParameterizedTest
    @MethodSource("escapePayloads")
    void everyEscapeIsRejected(String payload) throws Exception {
        MvcResult result = mvc.perform(post("/v1/render")
                        .contentType("application/json")
                        .content(renderRequest(payload)))
                .andExpect(status().isUnprocessableEntity())
                .andReturn();
        String body = result.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
        assertThat(body).contains("sandbox-violation");
        assertThat(result.getResponse().getHeader("X-Render-Meta")).isNull();
    }

    @org.junit.jupiter.api.Test
    void benignExpressionsStillRender() throws Exception {
        // negative control: the whitelist keeps pure functions working
        mvc.perform(post("/v1/render")
                        .contentType("application/json")
                        .content(renderRequest("upper(name)")))
                .andExpect(status().isOk());
    }

    @org.junit.jupiter.api.Test
    void plainPropertyAccessStillRenders() throws Exception {
        mvc.perform(post("/v1/render")
                        .contentType("application/json")
                        .content(renderRequest("name")))
                .andExpect(status().isOk());
    }
}
