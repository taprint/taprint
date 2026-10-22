/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.render.web;

import dev.taprint.render.core.RenderRequest;
import dev.taprint.render.core.RenderOrchestrator;
import dev.taprint.render.core.RenderedOutput;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * v1 HTTP surface (contract: schema/render-api.json):
 *
 * <ul>
 *   <li>{@code POST /v1/render} — binary command stream + {@code X-Render-Meta}
 *       header ({@code {"byteCount", "frameSummary[]"}}, same meta shape as the
 *       MCP compile response)</li>
 *   <li>{@code POST /v1/preview} — PNG preview; outside the current kernel
 *       capability, answered with an explicit 422 (no silent degradation)</li>
 *   <li>{@code GET /healthz} — liveness</li>
 * </ul>
 *
 * <p>Inline templates only — there is no {@code templateUrl} parameter
 * (ADR-0012), so the service has no outbound-fetch surface.</p>
 */
@RestController
public class RenderController {

    /** Slack for the JSON envelope around template + data. */
    private static final int ENVELOPE_SLACK_BYTES = 65_536;

    private final RenderOrchestrator orchestrator;
    private final dev.taprint.render.config.RenderProperties props;

    public RenderController(RenderOrchestrator orchestrator,
                            dev.taprint.render.config.RenderProperties props) {
        this.orchestrator = orchestrator;
        this.props = props;
    }

    @PostMapping(value = "/v1/render")
    public ResponseEntity<byte[]> render(HttpServletRequest request) throws IOException {
        byte[] body = readBody(request);
        RenderRequest req = RenderRequest.parse(body, props);
        RenderedOutput out = orchestrator.render(req);
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(out.mimeType()))
                .header("X-Render-Meta", out.metaHeaderJson())
                .body(out.payload());
    }

    @PostMapping(value = "/v1/preview")
    public ResponseEntity<byte[]> preview(HttpServletRequest request) throws IOException {
        byte[] body = readBody(request);
        RenderRequest req = RenderRequest.parse(body, props);
        RenderedOutput out = orchestrator.preview(req);
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(out.mimeType()))
                .header("X-Render-Meta", out.metaHeaderJson())
                .body(out.payload());
    }

    @GetMapping(value = "/healthz")
    public ResponseEntity<Map<String, String>> health() {
        return ResponseEntity.status(HttpStatus.OK)
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("status", "ok", "service", "taprint-render"));
    }

    /**
     * Reads the request entity under a hard byte cap
     * (template + data + envelope slack); anything larger is rejected with 413
     * before it can stress the heap.
     */
    private byte[] readBody(HttpServletRequest request) throws IOException {
        long cap = (long) props.getTemplateMaxBytes() + props.getDataMaxBytes() + ENVELOPE_SLACK_BYTES;
        ByteArrayOutputStream out = new ByteArrayOutputStream(8192);
        try (InputStream in = request.getInputStream()) {
            byte[] buf = new byte[8192];
            int n;
            long total = 0;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > cap) {
                    throw ApiException.payloadTooLarge("request-too-large",
                            "Request body exceeds the hard cap of " + cap + " bytes "
                                    + "(template <= " + props.getTemplateMaxBytes()
                                    + " B, data <= " + props.getDataMaxBytes() + " B)");
                }
                out.write(buf, 0, n);
            }
        }
        return out.toByteArray();
    }

    static String utf8(byte[] bytes) {
        return new String(bytes, StandardCharsets.UTF_8);
    }
}
