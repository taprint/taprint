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
import org.springframework.test.web.servlet.MvcResult;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * v1 legal-path rendering for the three kernel-supported targets plus
 * health and the explicit preview capability answer.
 */
@SpringBootTest
@AutoConfigureMockMvc
class RenderApiTest {

    @Autowired
    private MockMvc mvc;

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Receipt template with an ESC @ init command so byte 0 is provable. */
    static ObjectNode receiptTemplate() {
        ObjectNode template = JSON.createObjectNode();
        template.put("schemaVersion", "1.0");
        template.put("id", "render_api_receipt");
        template.put("code", "RENDER_API_RECEIPT");
        template.put("name", "render api receipt");
        ObjectNode receipt = template.putObject("presentations").putObject("receipt");
        receipt.put("width", "80mm");
        receipt.put("encoding", "gbk");
        receipt.putArray("initCommands").add("ESC @");
        ObjectNode name = receipt.putArray("body").addObject();
        name.put("type", "text");
        name.put("content", "{{name}}");
        name.put("align", "center");
        ObjectNode total = receipt.putArray("body").addObject();
        total.put("type", "text");
        total.put("content", "{{totalAmount}}");
        return template;
    }

    static ObjectNode labelTemplate() {
        ObjectNode template = JSON.createObjectNode();
        template.put("schemaVersion", "1.1");
        template.put("id", "render_api_label");
        template.put("code", "RENDER_API_LABEL");
        template.put("name", "render api label");
        ObjectNode label = template.putObject("presentations").putObject("label");
        ObjectNode size = label.putObject("size");
        size.put("width", "40mm");
        size.put("height", "30mm");
        label.put("gap", "2mm");
        ObjectNode text = label.putArray("body").addObject();
        text.put("type", "text");
        text.put("content", "{{name}}");
        text.put("x", "2mm");
        text.put("y", "2mm");
        return template;
    }

    static ObjectNode request(ObjectNode template, String target, ObjectNode data, ObjectNode options) {
        ObjectNode root = JSON.createObjectNode();
        root.set("template", template);
        root.put("target", target);
        if (data != null) {
            root.set("data", data);
        }
        if (options != null) {
            root.set("options", options);
        }
        return root;
    }

    static ObjectNode renderData() {
        ObjectNode data = JSON.createObjectNode();
        data.put("name", "张三");
        data.put("totalAmount", "38.00");
        return data;
    }

    @Test
    void healthzOk() throws Exception {
        mvc.perform(get("/healthz"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("ok"));
    }

    @Test
    void renderEscPosOk() throws Exception {
        MvcResult result = mvc.perform(post("/v1/render")
                        .contentType("application/json")
                        .content(request(receiptTemplate(), "escpos", renderData(), null).toString()))
                .andExpect(status().isOk())
                .andReturn();
        byte[] payload = result.getResponse().getContentAsByteArray();
        assertThat(payload.length).isPositive();
        // ESC @ init frame
        assertThat(payload[0] & 0xFF).isEqualTo(0x1B);
        assertThat(payload[1] & 0xFF).isEqualTo(0x40);
        RenderedMeta meta = meta(result);
        assertThat(meta.byteCount).isEqualTo(payload.length);
        assertThat(meta.frameSummary).contains("INIT");
    }

    @Test
    void renderTsplOk() throws Exception {
        MvcResult result = mvc.perform(post("/v1/render")
                        .contentType("application/json")
                        .content(request(labelTemplate(), "tspl", renderData(), null).toString()))
                .andExpect(status().isOk())
                .andReturn();
        byte[] payload = result.getResponse().getContentAsByteArray();
        String body = new String(payload, java.nio.charset.StandardCharsets.ISO_8859_1);
        assertThat(body).startsWith("SIZE 40 mm,30 mm");
        assertThat(body).contains("PRINT 1");
        RenderedMeta meta = meta(result);
        assertThat(meta.byteCount).isEqualTo(payload.length);
        assertThat(meta.frameSummary).contains("CLS", "PRINT 1");
    }

    @Test
    void renderCpclOk() throws Exception {
        MvcResult result = mvc.perform(post("/v1/render")
                        .contentType("application/json")
                        .content(request(labelTemplate(), "cpcl", renderData(), null).toString()))
                .andExpect(status().isOk())
                .andReturn();
        byte[] payload = result.getResponse().getContentAsByteArray();
        String body = new String(payload, java.nio.charset.StandardCharsets.ISO_8859_1);
        assertThat(body).startsWith("! 0 200 200 ");
        assertThat(body).contains("FORM");
        assertThat(body).contains("PRINT");
        assertThat(meta(result).byteCount).isEqualTo(payload.length);
    }

    @Test
    void previewIsExplicit422() throws Exception {
        mvc.perform(post("/v1/preview")
                        .contentType("application/json")
                        .content(request(receiptTemplate(), "escpos", renderData(), null).toString()))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.error.code").value("preview-unsupported"));
    }

    record RenderedMeta(int byteCount, java.util.List<String> frameSummary) {
    }

    static RenderedMeta meta(MvcResult result) throws Exception {
        String header = result.getResponse().getHeader("X-Render-Meta");
        assertThat(header).isNotBlank();
        com.fasterxml.jackson.databind.JsonNode node = JSON.readTree(header);
        java.util.List<String> summary = new java.util.ArrayList<>();
        node.get("frameSummary").forEach(n -> summary.add(n.asText()));
        return new RenderedMeta(node.get("byteCount").asInt(), summary);
    }
}
