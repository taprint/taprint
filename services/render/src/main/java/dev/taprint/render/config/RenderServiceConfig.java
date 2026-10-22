/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.render.config;

import dev.taprint.render.core.RenderKernel;
import dev.taprint.render.web.ApiKeyAuthFilter;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;

import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Service wiring: the render worker pool (resource-capped, bounded queue),
 * the kernel facade and the API-key filter.
 */
@Configuration
public class RenderServiceConfig {

    /**
     * Bounded worker pool: renders run here, never on request threads, so a
     * slow or hostile template occupies at most {@code workerPoolSize} threads
     * and the wall-clock budget cancels the rest (ADR-0012).
     */
    @Bean(destroyMethod = "shutdown")
    public ThreadPoolExecutor renderWorkerPool(RenderProperties props) {
        ThreadFactory factory = new ThreadFactory() {
            private final AtomicInteger seq = new AtomicInteger();

            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "taprint-render-worker-" + seq.incrementAndGet());
                t.setDaemon(false);
                return t;
            }
        };
        return new ThreadPoolExecutor(
                props.getWorkerPoolSize(), props.getWorkerPoolSize(),
                0L, TimeUnit.MILLISECONDS,
                new LinkedBlockingQueue<>(props.getWorkerQueueCapacity()),
                factory,
                new ThreadPoolExecutor.AbortPolicy());
    }

    /** Kernel facade over the taprint Java kernel (empty host-function registry). */
    @Bean
    public RenderKernel renderKernel() {
        return RenderKernel.standard();
    }

    /** X-API-Key filter for /v1/* endpoints; no-op while no keys are configured. */
    @Bean
    public FilterRegistrationBean<ApiKeyAuthFilter> apiKeyAuthFilter(RenderProperties props) {
        FilterRegistrationBean<ApiKeyAuthFilter> reg = new FilterRegistrationBean<>();
        reg.setFilter(new ApiKeyAuthFilter(props.getApiKeys()));
        reg.addUrlPatterns("/v1/*");
        reg.setOrder(Ordered.HIGHEST_PRECEDENCE);
        return reg;
    }
}
