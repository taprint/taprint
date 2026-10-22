/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.render.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpStatus;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

/**
 * Static API-key authentication on /v1/* via the {@code X-API-Key} header.
 *
 * <p>Keys are injected through configuration (env {@code TAPRINT_RENDER_API_KEYS},
 * comma-separated). While the configured key list is empty the filter is a
 * no-op: auth is disabled, which is acceptable only for loopback/local
 * evaluation. Exposing the service on any shared network without keys is
 * strongly discouraged (see services/render/README.md).</p>
 */
public class ApiKeyAuthFilter extends OncePerRequestFilter {

    public static final String HEADER = "X-API-Key";

    private final List<String> apiKeys;

    public ApiKeyAuthFilter(List<String> apiKeys) {
        this.apiKeys = apiKeys == null ? List.of() : apiKeys.stream()
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .toList();
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        // Auth disabled while no keys are configured.
        return apiKeys.isEmpty();
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String key = request.getHeader(HEADER);
        if (key == null || key.isBlank()) {
            reject(response, "missing-api-key", "Missing required header " + HEADER);
            return;
        }
        if (!apiKeys.contains(key)) {
            reject(response, "invalid-api-key", "Unknown " + HEADER + " value");
            return;
        }
        chain.doFilter(request, response);
    }

    private void reject(HttpServletResponse response, String code, String message) throws IOException {
        response.setStatus(HttpStatus.UNAUTHORIZED.value());
        response.setContentType("application/json;charset=UTF-8");
        response.getWriter().write(json(code, message));
    }

    private String json(String code, String message) {
        return "{\"error\":{\"code\":\"" + code + "\",\"message\":\""
                + message.replace("\\", "\\\\").replace("\"", "\\\"") + "\"}}";
    }
}
