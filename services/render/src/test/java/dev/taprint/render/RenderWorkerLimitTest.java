/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.render;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.taprint.core.CommandSet;
import dev.taprint.core.DeviceClass;
import dev.taprint.dsl.TemplateDsl;
import dev.taprint.render.config.RenderProperties;
import dev.taprint.render.core.RenderKernel;
import dev.taprint.render.core.RenderOrchestrator;
import dev.taprint.render.core.RenderRequest;
import dev.taprint.render.web.ApiException;
import dev.taprint.renderer.EvaluatedTemplate;
import dev.taprint.renderer.RenderContext;
import dev.taprint.renderer.RenderResult;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Hard-limit behaviour of the orchestrator against stub kernels: output cap,
 * wall-clock cancellation with worker interrupt, and kernel error mapping.
 * Runs without Spring; the pool under test uses daemon threads.
 */
class RenderWorkerLimitTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String RECEIPT_JSON = """
            {"schemaVersion":"1.0","id":"worker_limit_receipt","code":"WORKER_LIMIT_RECEIPT",
             "name":"worker limit receipt",
             "presentations":{"receipt":{"width":"80mm","encoding":"gbk",
               "body":[{"type":"text","content":"{{name}}"}]}}}
            """;

    private static ThreadPoolExecutor daemonPool(int size) {
        return new ThreadPoolExecutor(size, size, 0L, TimeUnit.MILLISECONDS,
                new LinkedBlockingQueue<>(8), r -> {
            Thread t = new Thread(r, "worker-limit-test");
            t.setDaemon(true);
            return t;
        });
    }

    private static RenderProperties props(long wallClockMillis, long outputMaxBytes) {
        RenderProperties p = new RenderProperties();
        p.setWallClockMillis(wallClockMillis);
        p.setOutputMaxBytes(outputMaxBytes);
        return p;
    }

    private static RenderRequest receiptRequest() {
        ObjectNode root = JSON.createObjectNode();
        try {
            root.set("template", JSON.readTree(RECEIPT_JSON));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
        root.put("target", "escpos");
        return RenderRequest.parse(root.toString().getBytes(StandardCharsets.UTF_8), new RenderProperties());
    }

    @Test
    void outputOverCap413() {
        RenderKernel fat = new RenderKernel() {
            @Override
            public EvaluatedTemplate eval(TemplateDsl dsl, DeviceClass dc, Map<String, Object> data) {
                return new EvaluatedTemplate();
            }

            @Override
            public RenderResult render(CommandSet cs, EvaluatedTemplate e, RenderContext ctx) {
                return new RenderResult(new byte[2048], "application/octet-stream", cs);
            }
        };
        ThreadPoolExecutor pool = daemonPool(1);
        try {
            RenderOrchestrator orch = new RenderOrchestrator(pool, fat, props(10_000, 1024));
            assertThatThrownBy(() -> orch.render(receiptRequest()))
                    .isInstanceOfSatisfying(ApiException.class, ex -> {
                        assertThat(ex.getCode()).isEqualTo("output-too-large");
                        assertThat(ex.getStatus().value()).isEqualTo(413);
                    });
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void wallClockExceededCancelsWorker() {
        AtomicBoolean interrupted = new AtomicBoolean(false);
        RenderKernel slow = new RenderKernel() {
            @Override
            public EvaluatedTemplate eval(TemplateDsl dsl, DeviceClass dc, Map<String, Object> data) {
                return new EvaluatedTemplate();
            }

            @Override
            public RenderResult render(CommandSet cs, EvaluatedTemplate e, RenderContext ctx) {
                try {
                    Thread.sleep(10_000);
                } catch (InterruptedException ie) {
                    interrupted.set(true);
                    Thread.currentThread().interrupt();
                }
                return new RenderResult(new byte[16], "application/octet-stream", cs);
            }
        };
        ThreadPoolExecutor pool = daemonPool(1);
        try {
            RenderOrchestrator orch = new RenderOrchestrator(pool, slow, props(300, 52_428_800));
            long start = System.nanoTime();
            assertThatThrownBy(() -> orch.render(receiptRequest()))
                    .isInstanceOfSatisfying(ApiException.class, ex -> {
                        assertThat(ex.getCode()).isEqualTo("wall-clock-exceeded");
                        assertThat(ex.getStatus().value()).isEqualTo(422);
                    });
            long elapsedMs = (System.nanoTime() - start) / 1_000_000;
            assertThat(elapsedMs).isLessThan(2_500);
            assertThat(interrupted).isTrue();
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void structurallyInvalidTemplate422() throws Exception {
        ThreadPoolExecutor pool = daemonPool(1);
        try {
            RenderOrchestrator orch = new RenderOrchestrator(pool, RenderKernel.standard(), props(10_000, 52_428_800));
            com.fasterxml.jackson.databind.node.ObjectNode template =
                    (com.fasterxml.jackson.databind.node.ObjectNode) JSON.readTree(RECEIPT_JSON);
            template.put("schemaVersion", "9.9");
            ObjectNode root = JSON.createObjectNode();
            root.set("template", template);
            root.put("target", "escpos");
            RenderRequest req = RenderRequest.parse(root.toString().getBytes(StandardCharsets.UTF_8), new RenderProperties());
            assertThatThrownBy(() -> orch.render(req))
                    .isInstanceOfSatisfying(ApiException.class, ex -> {
                        assertThat(ex.getCode()).isEqualTo("template-invalid");
                        assertThat(ex.getStatus().value()).isEqualTo(422);
                    });
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void receiptTemplateOnLabelTarget422() {
        ThreadPoolExecutor pool = daemonPool(1);
        try {
            RenderOrchestrator orch = new RenderOrchestrator(pool, RenderKernel.standard(), props(10_000, 52_428_800));
            ObjectNode root = JSON.createObjectNode();
            try {
                root.set("template", JSON.readTree(RECEIPT_JSON));
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
            root.put("target", "cpcl");
            RenderRequest req = RenderRequest.parse(root.toString().getBytes(StandardCharsets.UTF_8), new RenderProperties());
            assertThatThrownBy(() -> orch.render(req))
                    .isInstanceOfSatisfying(ApiException.class, ex -> {
                        assertThat(ex.getCode()).isEqualTo("missing-presentation");
                    });
        } finally {
            pool.shutdownNow();
        }
    }
}
