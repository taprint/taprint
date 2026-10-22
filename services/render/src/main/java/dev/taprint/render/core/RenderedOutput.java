/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.render.core;

import java.util.List;

/**
 * Render response assembly: binary payload plus the meta shape shared with
 * the MCP compile response ({@code byteCount} + {@code frameSummary[]}).
 * The meta travels in the {@code X-Render-Meta} response header as
 * ASCII-escaped JSON so it is safe for any HTTP infrastructure.
 */
public final class RenderedOutput {

    /** Response header carrying the meta JSON. */
    public static final String META_HEADER = "X-Render-Meta";

    public final byte[] payload;
    public final String mimeType;
    public final int byteCount;
    public final List<String> frameSummary;

    public RenderedOutput(byte[] payload, String mimeType, List<String> frameSummary) {
        this.payload = payload;
        this.mimeType = mimeType;
        this.byteCount = payload == null ? 0 : payload.length;
        this.frameSummary = frameSummary == null ? List.of() : List.copyOf(frameSummary);
    }

    public byte[] payload() {
        return payload;
    }

    public String mimeType() {
        return mimeType;
    }

    /** ASCII-safe JSON: {@code {"byteCount":N,"frameSummary":[...]}}. */
    public String metaHeaderJson() {
        StringBuilder sb = new StringBuilder(64 + frameSummary.size() * 16);
        sb.append("{\"byteCount\":").append(byteCount).append(",\"frameSummary\":[");
        for (int i = 0; i < frameSummary.size(); i++) {
            if (i > 0) {
                sb.append(',');
            }
            sb.append('"').append(escape(frameSummary.get(i))).append('"');
        }
        sb.append("]}");
        return sb.toString();
    }

    private static String escape(String s) {
        StringBuilder out = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < 0x20 || c > 0x7E || c == '"' || c == '\\') {
                out.append(String.format("\\u%04x", (int) c));
            } else {
                out.append(c);
            }
        }
        return out.toString();
    }
}
