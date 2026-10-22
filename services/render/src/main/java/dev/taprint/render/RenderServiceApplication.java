/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.render;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

/**
 * taprint-render entry point: self-hosted HTTP render service over the
 * taprint Java kernel (ADR-0004), with hard resource limits and a sandboxed
 * expression engine (ADR-0012).
 */
@SpringBootApplication
@ConfigurationPropertiesScan
public class RenderServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(RenderServiceApplication.class, args);
    }
}
