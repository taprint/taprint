/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.render.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.taprint.render.config.RenderProperties;
import dev.taprint.render.web.ApiException;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;

/**
 * Parsed and limit-checked v1 render/preview request.
 *
 * <p>Status-code discipline (contract: schema/render-api.json):</p>
 * <ul>
 *   <li><b>400</b> — syntactic problems: malformed JSON, missing/wrong-typed
 *       required fields, unknown target value;</li>
 *   <li><b>413</b> — size caps: template over 1 MiB (also covered by the raw
 *       body cap in the controller);</li>
 *   <li><b>422</b> — well-formed but unprocessable: option values outside the
 *       contract ranges (dpi / widthMm / copies), and everything the kernel or
 *       the sandbox rejects further down the pipeline.</li>
 * </ul>
 */
public final class RenderRequest {

    /** v1 contract targets. ZPL is contract-valid but unsupported by the Java kernel. */
    public static final Set<String> TARGETS = Set.of("escpos", "tspl", "cpcl", "zpl");

    private static final ObjectMapper MAPPER = JsonMapper.builder().build();

    /** Compact JSON serialization of the template object (limit-checked). */
    public final String templateJson;
    /** Root data scope; never null. */
    public final Map<String, Object> data;
    /** One of {@link #TARGETS}. */
    public final String target;
    public final Integer dpi;
    public final Double widthMm;
    public final Integer copies;

    private RenderRequest(String templateJson, Map<String, Object> data, String target,
                          Integer dpi, Double widthMm, Integer copies) {
        this.templateJson = templateJson;
        this.data = data;
        this.target = target;
        this.dpi = dpi;
        this.widthMm = widthMm;
        this.copies = copies;
    }

    public static RenderRequest parse(byte[] body, RenderProperties props) {
        JsonNode root;
        try {
            root = MAPPER.readTree(body);
        } catch (Exception e) {
            throw ApiException.badRequest("malformed-json",
                    "Request body is not valid JSON: " + firstLine(e.getMessage()));
        }
        if (root == null || !root.isObject()) {
            throw ApiException.badRequest("bad-request", "Request body must be a JSON object");
        }

        JsonNode template = root.get("template");
        if (template == null) {
            throw ApiException.badRequest("missing-template", "Field 'template' is required");
        }
        if (!template.isObject()) {
            throw ApiException.badRequest("bad-template", "Field 'template' must be a JSON object (inline DSL)");
        }
        String templateJson = template.toString();
        if (templateJson.getBytes(StandardCharsets.UTF_8).length > props.getTemplateMaxBytes()) {
            throw ApiException.payloadTooLarge("template-too-large",
                    "Template exceeds the hard cap of " + props.getTemplateMaxBytes() + " bytes");
        }

        String target = fieldText(root, "target");
        if (target == null) {
            throw ApiException.badRequest("missing-target", "Field 'target' is required (escpos|tspl|cpcl|zpl)");
        }
        if (!TARGETS.contains(target)) {
            throw ApiException.badRequest("unknown-target",
                    "Unknown target '" + target + "' (supported: escpos, tspl, cpcl, zpl)");
        }

        Map<String, Object> data = new HashMap<>();
        JsonNode dataNode = root.get("data");
        if (dataNode != null && !dataNode.isNull()) {
            if (!dataNode.isObject()) {
                throw ApiException.badRequest("bad-data", "Field 'data' must be a JSON object");
            }
            data = MAPPER.convertValue(dataNode, new com.fasterxml.jackson.core.type.TypeReference<Map<String, Object>>() {
            });
        }

        Integer dpi = null;
        Double widthMm = null;
        Integer copies = null;
        JsonNode options = root.get("options");
        if (options != null && !options.isNull()) {
            if (!options.isObject()) {
                throw ApiException.badRequest("bad-options", "Field 'options' must be a JSON object");
            }
            dpi = intOption((ObjectNode) options, "dpi");
            if (dpi != null && !props.getAllowedDpis().contains(dpi)) {
                throw ApiException.unprocessable("option-out-of-range",
                        "dpi=" + dpi + " is outside the allowed set " + props.getAllowedDpis());
            }
            JsonNode widthNode = options.get("widthMm");
            if (widthNode != null && !widthNode.isNull()) {
                if (!widthNode.isNumber()) {
                    throw ApiException.badRequest("bad-option-type", "options.widthMm must be a number");
                }
                widthMm = widthNode.asDouble();
                if (widthMm <= 0 || widthMm > props.getMaxWidthMm()) {
                    throw ApiException.unprocessable("option-out-of-range",
                            "widthMm=" + widthMm + " is outside the allowed range (0, " + props.getMaxWidthMm() + "]");
                }
            }
            copies = intOption((ObjectNode) options, "copies");
            if (copies != null && (copies < 1 || copies > props.getMaxCopies())) {
                throw ApiException.unprocessable("option-out-of-range",
                        "copies=" + copies + " is outside the allowed range [1, " + props.getMaxCopies() + "]");
            }
        }
        return new RenderRequest(templateJson, data, target, dpi, widthMm, copies);
    }

    private static String fieldText(JsonNode root, String field) {
        JsonNode n = root.get(field);
        return n != null && n.isTextual() ? n.asText() : null;
    }

    private static Integer intOption(ObjectNode options, String field) {
        JsonNode n = options.get(field);
        if (n == null || n.isNull()) {
            return null;
        }
        if (!n.isIntegralNumber()) {
            throw ApiException.badRequest("bad-option-type", "options." + field + " must be an integer");
        }
        return n.asInt();
    }

    private static String firstLine(String msg) {
        if (msg == null) {
            return "";
        }
        int nl = msg.indexOf('\n');
        return nl > 0 ? msg.substring(0, nl) : msg;
    }
}
