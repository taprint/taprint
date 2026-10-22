/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.render;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;

import java.nio.charset.StandardCharsets;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Over-limit matrix and request-shape errors: explicit 400 / 413 / 422
 * distinctions per schema/render-api.json (ADR-0012 hard limits).
 */
@SpringBootTest
@AutoConfigureMockMvc
class RenderLimitsTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Autowired
    private MockMvc mvc;

    private ResultActions render(ObjectNode root) throws Exception {
        return mvc.perform(post("/v1/render")
                .contentType("application/json")
                .content(root.toString()));
    }

    private ObjectNode receiptRequest() {
        return RenderApiTest.request(RenderApiTest.receiptTemplate(), "escpos", RenderApiTest.renderData(), null);
    }

    private ObjectNode labelRequest(String target) {
        return RenderApiTest.request(RenderApiTest.labelTemplate(), target, RenderApiTest.renderData(), null);
    }

    // ---- 413: size caps ----

    @Test
    void templateOverHardCap413() throws Exception {
        ObjectNode root = receiptRequest();
        ((ObjectNode) root.get("template").get("presentations").get("receipt").get("body").get(0))
                .put("content", "A".repeat(1_100_000));
        render(root).andExpect(status().isPayloadTooLarge())
                .andExpect(jsonPath("$.error.code").value("template-too-large"));
    }

    @Test
    void requestBodyOverEnvelopeCap413() throws Exception {
        ObjectNode root = receiptRequest();
        ObjectNode data = JSON.createObjectNode();
        data.put("blob", "B".repeat(9_600_000));
        root.set("data", data);
        mvc.perform(post("/v1/render")
                        .contentType("application/json")
                        .content(root.toString().getBytes(StandardCharsets.UTF_8)))
                .andExpect(status().isPayloadTooLarge())
                .andExpect(jsonPath("$.error.code").value("request-too-large"));
    }

    // ---- 422: option ranges ----

    @Test
    void copiesZero422() throws Exception {
        render(options(receiptRequest(), "copies", 0))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.error.code").value("option-out-of-range"));
    }

    @Test
    void copiesOverMax422() throws Exception {
        render(options(receiptRequest(), "copies", 201))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.error.code").value("option-out-of-range"));
    }

    @Test
    void escPosCopiesNotSupported422() throws Exception {
        render(options(receiptRequest(), "copies", 2))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.error.code").value("option-not-supported"));
    }

    @Test
    void labelCopiesAtMax200Ok() throws Exception {
        render(options(labelRequest("tspl"), "copies", 200))
                .andExpect(status().isOk());
    }

    @Test
    void widthMmZero422() throws Exception {
        render(options(labelRequest("tspl"), "widthMm", 0))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.error.code").value("option-out-of-range"));
    }

    @Test
    void widthMmOverMax422() throws Exception {
        render(options(labelRequest("tspl"), "widthMm", 300.5))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.error.code").value("option-out-of-range"));
    }

    @Test
    void widthMmOverrideReflectedInSummary() throws Exception {
        render(options(labelRequest("tspl"), "widthMm", 60))
                .andExpect(status().isOk());
    }

    @Test
    void dpiOutOfRange422() throws Exception {
        render(options(receiptRequest(), "dpi", 150))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.error.code").value("option-out-of-range"));
    }

    @Test
    void dpi300Accepted() throws Exception {
        render(options(receiptRequest(), "dpi", 300))
                .andExpect(status().isOk());
    }

    @Test
    void dpiNonInteger400() throws Exception {
        ObjectNode root = receiptRequest();
        root.putObject("options").put("dpi", "fast");
        render(root).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("bad-option-type"));
    }

    // ---- target handling ----

    @Test
    void zplTargetExplicit422() throws Exception {
        render(labelRequest("zpl"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.error.code").value("target-unsupported"));
    }

    @Test
    void unknownTargetValue400() throws Exception {
        render(labelRequest("pdf"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("unknown-target"));
    }

    // ---- 400: request shape ----

    @Test
    void malformedJson400() throws Exception {
        mvc.perform(post("/v1/render").contentType("application/json").content("{nope"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("malformed-json"));
    }

    @Test
    void missingTarget400() throws Exception {
        ObjectNode root = receiptRequest();
        root.remove("target");
        render(root).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("missing-target"));
    }

    @Test
    void templateNotObject400() throws Exception {
        ObjectNode root = JSON.createObjectNode();
        root.put("template", "{\"schemaVersion\":\"1.0\"}");
        root.put("target", "escpos");
        render(root).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("bad-template"));
    }

    @Test
    void dataNotObject400() throws Exception {
        ObjectNode root = receiptRequest();
        root.put("data", 42);
        render(root).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("bad-data"));
    }

    // ---- 422: template semantics ----

    @Test
    void wrongPresentationForTarget422() throws Exception {
        // receipt-only template rendered to a label target
        render(RenderApiTest.request(RenderApiTest.receiptTemplate(), "tspl", RenderApiTest.renderData(), null))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.error.code").value("missing-presentation"));
    }

    private ObjectNode options(ObjectNode root, String field, Object value) {
        ObjectNode opts = root.putObject("options");
        if (value instanceof Integer i) {
            opts.put(field, i);
        } else if (value instanceof Double d) {
            opts.put(field, d);
        } else {
            opts.put(field, String.valueOf(value));
        }
        return root;
    }
}
