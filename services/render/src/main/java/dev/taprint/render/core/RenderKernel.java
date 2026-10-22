/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.render.core;

import dev.taprint.core.CommandSet;
import dev.taprint.core.DeviceClass;
import dev.taprint.dsl.TemplateDsl;
import dev.taprint.expression.FilterRegistry;
import dev.taprint.expression.HostFunctions;
import dev.taprint.expression.PrintExpressionEvaluator;
import dev.taprint.expression.QLExpress4Engine;
import dev.taprint.expression.SandboxPolicy;
import dev.taprint.core.KernelOptions;
import dev.taprint.renderer.EvaluatedTemplate;
import dev.taprint.renderer.RenderContext;
import dev.taprint.renderer.RenderResult;
import dev.taprint.renderer.RendererRegistry;
import dev.taprint.Taprint;

import java.util.Map;

/**
 * Seam between the HTTP service and the taprint Java kernel, kept narrow so
 * tests can stub slow/oversized kernels without building a real one.
 *
 * <p>The default implementation wires the standard kernel with
 * {@link HostFunctions#EMPTY}: host functions are registered by nobody by
 * default, so templates calling them fail explicitly (ADR-0007/0012).</p>
 */
public interface RenderKernel {

    EvaluatedTemplate eval(TemplateDsl dsl, DeviceClass deviceClass, Map<String, Object> data);

    RenderResult render(CommandSet commandSet, EvaluatedTemplate evaluated, RenderContext ctx);

    /** Standard kernel assembly: StrategyIsolation sandbox, no host functions. */
    static RenderKernel standard() {
        KernelOptions options = new KernelOptions();
        SandboxPolicy sandboxPolicy = new SandboxPolicy(options);
        FilterRegistry filters = new FilterRegistry();
        QLExpress4Engine engine = new QLExpress4Engine(sandboxPolicy, filters, HostFunctions.EMPTY);
        PrintExpressionEvaluator evaluator =
                new PrintExpressionEvaluator(engine, filters, sandboxPolicy, options);
        RendererRegistry registry = new RendererRegistry(Taprint.standardRenderers(null));
        return new RenderKernel() {
            @Override
            public EvaluatedTemplate eval(TemplateDsl dsl, DeviceClass deviceClass,
                                          Map<String, Object> data) {
                return evaluator.eval(dsl, deviceClass, data);
            }

            @Override
            public RenderResult render(CommandSet commandSet, EvaluatedTemplate evaluated,
                                       RenderContext ctx) {
                return registry.get(commandSet).render(evaluated, ctx);
            }
        };
    }
}
