/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint;

import dev.taprint.barcode.BarcodeRenderer;
import dev.taprint.barcode.QrcodeRenderer;
import dev.taprint.core.KernelOptions;
import dev.taprint.expression.FilterRegistry;
import dev.taprint.expression.HostFunctions;
import dev.taprint.expression.PrintExpressionEvaluator;
import dev.taprint.expression.QLExpress4Engine;
import dev.taprint.expression.SandboxPolicy;
import dev.taprint.font.ClasspathFontProvider;
import dev.taprint.font.FontProvider;
import dev.taprint.renderer.CpclRenderer;
import dev.taprint.renderer.CjkRasterizer;
import dev.taprint.renderer.EscPosRenderer;
import dev.taprint.renderer.PdfRenderer;
import dev.taprint.renderer.PrintImageLoader;
import dev.taprint.renderer.Renderer;
import dev.taprint.renderer.RendererRegistry;
import dev.taprint.renderer.TsplRenderer;
import dev.taprint.renderer.ZplRenderer;

import java.util.List;

/**
 * Assembly point of the taprint Java kernel (factory, framework-free).
 *
 * <p>Hosts with no custom wiring start from {@link #standard()} and render
 * through the returned evaluator and renderer registry:</p>
 *
 * <pre>{@code
 * Taprint taprint = Taprint.standard();
 * EvaluatedTemplate evaluated = taprint.evaluator()
 *         .eval(dsl, DeviceClass.RECEIPT, data);
 * RenderResult result = taprint.renderers()
 *         .get(CommandSet.ESC_POS)
 *         .render(evaluated, RenderContext.builder().copies(1).build());
 * }</pre>
 *
 * <p>Host functions (ADR-0007) are opt-in: pass a {@link HostFunctions}
 * registry to {@link #standard(HostFunctions)}; without one, templates that
 * call host functions fail statically in
 * {@link dev.taprint.expression.ExpressionAudit} and explicitly at evaluation
 * time. Fonts (ADR-0002) come from the {@link FontProvider} SPI, defaulting
 * to the bundled Noto Sans SC classpath provider.</p>
 */
public final class Taprint {

    private final PrintExpressionEvaluator evaluator;
    private final RendererRegistry renderers;

    private Taprint(PrintExpressionEvaluator evaluator, RendererRegistry renderers) {
        this.evaluator = evaluator;
        this.renderers = renderers;
    }

    /** Standard kernel: default options, no host functions, classpath fonts. */
    public static Taprint standard() {
        return standard(HostFunctions.EMPTY);
    }

    /** Standard kernel with the given host-function registry. */
    public static Taprint standard(HostFunctions hostFunctions) {
        return of(new KernelOptions(), hostFunctions, new ClasspathFontProvider());
    }

    /** Full control: options, host functions and font provider. */
    public static Taprint of(KernelOptions options, HostFunctions hostFunctions,
                             FontProvider fontProvider) {
        KernelOptions opts = options == null ? new KernelOptions() : options;
        SandboxPolicy sandboxPolicy = new SandboxPolicy(opts);
        FilterRegistry filters = new FilterRegistry();
        QLExpress4Engine engine = new QLExpress4Engine(sandboxPolicy, filters, hostFunctions);
        PrintExpressionEvaluator evaluator =
                new PrintExpressionEvaluator(engine, filters, sandboxPolicy, opts);
        return new Taprint(evaluator, new RendererRegistry(standardRenderers(fontProvider)));
    }

    /** The default renderer set: ESC/POS, TSPL, CPCL, ZPL and PDF. */
    public static List<Renderer> standardRenderers(FontProvider fontProvider) {
        FontProvider provider = fontProvider == null ? new ClasspathFontProvider() : fontProvider;
        BarcodeRenderer barcodeRenderer = new BarcodeRenderer();
        QrcodeRenderer qrcodeRenderer = new QrcodeRenderer(barcodeRenderer);
        PrintImageLoader imageLoader = new PrintImageLoader();
        CjkRasterizer cjkRasterizer = new CjkRasterizer(provider);
        return List.of(
                new EscPosRenderer(qrcodeRenderer, imageLoader, cjkRasterizer),
                new TsplRenderer(imageLoader, cjkRasterizer),
                new CpclRenderer(cjkRasterizer, imageLoader),
                new ZplRenderer(),
                new PdfRenderer(barcodeRenderer, imageLoader, provider));
    }

    public PrintExpressionEvaluator evaluator() {
        return evaluator;
    }

    public RendererRegistry renderers() {
        return renderers;
    }
}
