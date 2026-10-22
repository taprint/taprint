/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.render;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * API-key auth switch: keys configured via properties (env
 * TAPRINT_RENDER_API_KEYS in production). Health stays open; /v1/* requires
 * X-API-Key. Auth-off behaviour is exercised by the other MockMvc suites
 * (same context, no keys configured).
 */
@SpringBootTest(properties = "taprint.render.api-keys=secret-a,secret-b")
@AutoConfigureMockMvc
class RenderAuthTest {

    @Autowired
    private MockMvc mvc;

    @Test
    void healthzStaysOpen() throws Exception {
        mvc.perform(get("/healthz")).andExpect(status().isOk());
    }

    @Test
    void missingKey401() throws Exception {
        mvc.perform(post("/v1/render").contentType("application/json").content("{}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("missing-api-key"));
    }

    @Test
    void wrongKey401() throws Exception {
        mvc.perform(post("/v1/render")
                        .header("X-API-Key", "nope")
                        .contentType("application/json").content("{}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("invalid-api-key"));
    }

    @Test
    void validKeyReachesHandler() throws Exception {
        // The key lets the request through to the handler, which then answers
        // 400 for the empty body — proving the filter passed it.
        mvc.perform(post("/v1/render")
                        .header("X-API-Key", "secret-b")
                        .contentType("application/json").content("{}"))
                .andExpect(status().isBadRequest());
    }
}
