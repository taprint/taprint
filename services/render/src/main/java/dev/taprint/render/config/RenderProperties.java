/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.render.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.List;

/**
 * Hard limits and operational knobs of the render service (ADR-0012).
 *
 * <p>Every limit here maps to an explicit 4xx response, never a silent
 * clamp: 413 for payload size caps, 422 for value-range violations and
 * wall-clock exhaustion. Defaults are the documented v1 contract values.</p>
 */
@ConfigurationProperties(prefix = "taprint.render")
public class RenderProperties {

    /** Template DSL hard cap in bytes (contract: 1 MiB). Exceeding: 413. */
    private int templateMaxBytes = 1_048_576;

    /** Request envelope cap beyond the template (untrusted data payload). Exceeding: 413. */
    private int dataMaxBytes = 8_388_608;

    /** Rendered output cap in bytes (contract: 50 MiB). Exceeding: 413. */
    private long outputMaxBytes = 52_428_800L;

    /** Wall-clock budget for one render, milliseconds (contract: 10 s). Exceeded: 422. */
    private long wallClockMillis = 10_000L;

    /** Bounded worker pool size; render never runs on request threads. */
    private int workerPoolSize = 4;

    /** Queued renders before the pool reports saturation (503). */
    private int workerQueueCapacity = 32;

    /** Allowed dpi values (contract: {203, 300}). */
    private List<Integer> allowedDpis = List.of(203, 300);

    /** Maximum paper width in mm (contract: 300). */
    private double maxWidthMm = 300.0;

    /** Maximum copies per render (contract: 200). */
    private int maxCopies = 200;

    /** API keys for X-API-Key auth. Empty list = auth disabled (strongly discouraged). */
    private List<String> apiKeys = List.of();

    public int getTemplateMaxBytes() {
        return templateMaxBytes;
    }

    public void setTemplateMaxBytes(int templateMaxBytes) {
        this.templateMaxBytes = templateMaxBytes;
    }

    public int getDataMaxBytes() {
        return dataMaxBytes;
    }

    public void setDataMaxBytes(int dataMaxBytes) {
        this.dataMaxBytes = dataMaxBytes;
    }

    public long getOutputMaxBytes() {
        return outputMaxBytes;
    }

    public void setOutputMaxBytes(long outputMaxBytes) {
        this.outputMaxBytes = outputMaxBytes;
    }

    public long getWallClockMillis() {
        return wallClockMillis;
    }

    public void setWallClockMillis(long wallClockMillis) {
        this.wallClockMillis = wallClockMillis;
    }

    public int getWorkerPoolSize() {
        return workerPoolSize;
    }

    public void setWorkerPoolSize(int workerPoolSize) {
        this.workerPoolSize = workerPoolSize;
    }

    public int getWorkerQueueCapacity() {
        return workerQueueCapacity;
    }

    public void setWorkerQueueCapacity(int workerQueueCapacity) {
        this.workerQueueCapacity = workerQueueCapacity;
    }

    public List<Integer> getAllowedDpis() {
        return allowedDpis;
    }

    public void setAllowedDpis(List<Integer> allowedDpis) {
        this.allowedDpis = allowedDpis;
    }

    public double getMaxWidthMm() {
        return maxWidthMm;
    }

    public void setMaxWidthMm(double maxWidthMm) {
        this.maxWidthMm = maxWidthMm;
    }

    public int getMaxCopies() {
        return maxCopies;
    }

    public void setMaxCopies(int maxCopies) {
        this.maxCopies = maxCopies;
    }

    public List<String> getApiKeys() {
        return apiKeys;
    }

    public void setApiKeys(List<String> apiKeys) {
        this.apiKeys = apiKeys;
    }
}
