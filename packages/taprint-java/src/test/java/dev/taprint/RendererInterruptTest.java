/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint;

import dev.taprint.core.PrintKernelException;
import dev.taprint.barcode.BarcodeRenderer;
import dev.taprint.barcode.QrcodeRenderer;
import dev.taprint.core.CommandSet;
import dev.taprint.core.KernelOptions;
import dev.taprint.dsl.BoxEdges;
import dev.taprint.dsl.DocPresentation;
import dev.taprint.dsl.DslStyle;
import dev.taprint.dsl.LabelPresentation;
import dev.taprint.dsl.PageSpec;
import dev.taprint.dsl.ReceiptPresentation;
import dev.taprint.core.PrintErrorCode;
import dev.taprint.renderer.CjkRasterizer;
import dev.taprint.renderer.CpclRenderer;
import dev.taprint.renderer.EscPosRenderer;
import dev.taprint.renderer.EvaluatedElement;
import dev.taprint.renderer.EvaluatedTemplate;
import dev.taprint.renderer.PdfRenderer;
import dev.taprint.renderer.PrintImageLoader;
import dev.taprint.renderer.RenderContext;
import dev.taprint.renderer.Renderer;
import dev.taprint.renderer.RenderResult;
import dev.taprint.renderer.TsplRenderer;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.awt.image.BufferedImage;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
  * Interrupt behavior: cancelled renders stop at element boundaries.
 * <p>口径：构造大元素列表 + 中断渲染线程，断言渲染器在元素边界检查点抛
 * 中断发生在渲染线程上（与 Future.cancel(true) 的真实路径一致）。
 */
class RendererInterruptTest {

    private static final int ELEMENT_COUNT = 100;

    private EvaluatedElement text(String content) {
        EvaluatedElement el = new EvaluatedElement();
        el.setType("text");
        el.setText(content);
        DslStyle style = new DslStyle();
        style.setFontSize(12);
        el.setStyle(style);
        return el;
    }

    private EvaluatedElement image(String src) {
        EvaluatedElement el = new EvaluatedElement();
        el.setType("image");
        el.setText(src);
        el.setWidth("10mm");
        el.setHeight("10mm");
        return el;
    }

    private List<EvaluatedElement> largeBody() {
        List<EvaluatedElement> body = new ArrayList<>();
        for (int i = 0; i < ELEMENT_COUNT; i++) {
            body.add(text("字段 " + i));
        }
        return body;
    }

    private CjkRasterizer initializedCjkRasterizer() {
        CjkRasterizer rasterizer = new CjkRasterizer();
        return rasterizer;
    }

    private EvaluatedTemplate receiptTemplate(List<EvaluatedElement> body) {
        EvaluatedTemplate t = new EvaluatedTemplate();
        ReceiptPresentation spec = new ReceiptPresentation();
        spec.setWidth("80mm");
        spec.setEncoding("gbk");
        t.setReceipt(spec);
        t.setBody(body);
        return t;
    }

    private EvaluatedTemplate labelTemplate(List<EvaluatedElement> body) {
        EvaluatedTemplate t = new EvaluatedTemplate();
        LabelPresentation spec = new LabelPresentation();
        PageSpec size = new PageSpec();
        size.setWidth("60mm");
        size.setHeight("40mm");
        spec.setSize(size);
        spec.setGap("2mm");
        spec.setDensity(8);
        spec.setSpeed(4);
        t.setLabel(spec);
        t.setBody(body);
        return t;
    }

    private EvaluatedTemplate docTemplate(List<EvaluatedElement> body) {
        EvaluatedTemplate t = new EvaluatedTemplate();
        DocPresentation doc = new DocPresentation();
        PageSpec page = new PageSpec();
        page.setSize("A4");
        page.setOrientation("portrait");
        BoxEdges margin = new BoxEdges();
        margin.setTop("15mm");
        margin.setBottom("15mm");
        margin.setLeft("15mm");
        margin.setRight("15mm");
        page.setMargin(margin);
        doc.setPage(page);
        t.setDoc(doc);
        t.setHeader(new ArrayList<EvaluatedElement>());
        t.setBody(body);
        t.setFooter(new ArrayList<EvaluatedElement>());
        return t;
    }

    /**
     * 在独立线程执行渲染并中断，断言 RENDER_TIMEOUT 抛出且线程退出。
     */
    private void assertInterruptThrowsRenderTimeout(Renderer renderer, EvaluatedTemplate template) throws Exception {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        CountDownLatch renderStarted = new CountDownLatch(1);
        Renderer guardedRenderer = new Renderer() {
            @Override
            public CommandSet getCommandSet() {
                return renderer.getCommandSet();
            }

            @Override
            public RenderResult render(EvaluatedTemplate evaluated, RenderContext context) {
                renderStarted.countDown();
                return renderer.render(evaluated, context);
            }
        };
        Thread worker = new Thread(() -> {
            try {
                guardedRenderer.render(template, RenderContext.builder().copies(1).build());
                failure.set(new AssertionError("render did not throw after interrupt"));
            } catch (Throwable t) {
                failure.set(t);
            }
        }, "renderer-interrupt-test");
        worker.start();
        renderStarted.await();
        worker.interrupt();
        worker.join(10000);
        Throwable t;
        try {
            assertFalse(worker.isAlive(), "render thread did not stop at the interrupt checkpoint");
        } finally {
            if (worker.isAlive()) {
                worker.interrupt();
                try {
                    worker.join(1000);
                } catch (InterruptedException cleanupInterrupted) {
                    Thread.currentThread().interrupt();
                    throw cleanupInterrupted;
                }
            }
        }
        t = failure.get();
        assertNotNull(t, "未捕获到渲染异常");
        assertTrue(t instanceof PrintKernelException, "期望 PrintKernelException，实际: " + t);
        PrintKernelException be = (PrintKernelException) t;
        assertEquals(PrintErrorCode.RENDER_TIMEOUT, be.getErrorCode(),
                "期望 RENDER_TIMEOUT，实际: " + be.getErrorCode());
    }

    private void assertCpclInterruptMapsToTimeout(InterruptAwareCjkRasterizer rasterizer,
                                                  List<EvaluatedElement> body) throws Exception {
        CountDownLatch rasterizeEntered = new CountDownLatch(1);
        InterruptAwareCjkRasterizer adapter = new InterruptAwareCjkRasterizer(false) {
            @Override
            public BufferedImage rasterize(String text, int heightDots) {
                rasterizeEntered.countDown();
                return rasterizer.rasterize(text, heightDots);
            }

            @Override
            boolean awaitRasterizeEntered(long timeout, TimeUnit unit) throws InterruptedException {
                return rasterizeEntered.await(timeout, unit);
            }
        };
        assertCpclInterruptMapsToTimeout(adapter, new PrintImageLoader(), body);
    }

    private void assertCpclImageInterruptMapsToTimeout(PrintImageLoader imageLoader,
                                                         List<EvaluatedElement> body) throws Exception {
        CpclRenderer renderer = new CpclRenderer(new CjkRasterizer(), imageLoader);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread worker = new Thread(() -> {
            try {
                renderer.render(labelTemplate(body), RenderContext.builder().copies(1).build());
                failure.set(new AssertionError("render did not throw after interrupt"));
            } catch (Throwable t) {
                failure.set(t);
            }
        }, "cpcl-image-interrupt-test");
        worker.start();
        worker.interrupt();
        worker.join(10000);
        if (worker.isAlive()) {
            worker.interrupt();
            worker.join(1000);
        }
        assertFalse(worker.isAlive(), "render thread did not stop at the interrupt checkpoint");
        Throwable t = failure.get();
        assertNotNull(t, "未捕获到渲染异常");
        assertTrue(t instanceof PrintKernelException, "期望 PrintKernelException，实际: " + t);
        assertEquals(PrintErrorCode.RENDER_TIMEOUT, ((PrintKernelException) t).getErrorCode(),
                "期望 RENDER_TIMEOUT，实际: " + ((PrintKernelException) t).getErrorCode());
    }

    private void assertCpclInterruptMapsToTimeout(InterruptAwareCjkRasterizer rasterizer,
                                                  PrintImageLoader imageLoader,
                                                  List<EvaluatedElement> body) throws Exception {
        CpclRenderer renderer = new CpclRenderer(rasterizer, imageLoader);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread worker = new Thread(() -> {
            try {
                renderer.render(labelTemplate(body), RenderContext.builder().copies(1).build());
                failure.set(new AssertionError("render did not throw after interrupt"));
            } catch (Throwable t) {
                failure.set(t);
            }
        }, "cpcl-renderer-interrupt-test");
        worker.start();
        assertTrue(rasterizer.awaitRasterizeEntered(10, TimeUnit.SECONDS),
                "未进入 CPCL 中文栅格化，定向夹具失效");
        worker.interrupt();
        worker.join(10000);
        Throwable t;
        try {
            assertFalse(worker.isAlive(), "render thread did not stop at the interrupt checkpoint");
        } finally {
            if (worker.isAlive()) {
                worker.interrupt();
                try {
                    worker.join(1000);
                } catch (InterruptedException cleanupInterrupted) {
                    Thread.currentThread().interrupt();
                    throw cleanupInterrupted;
                }
            }
        }
        t = failure.get();
        assertNotNull(t, "未捕获到渲染异常");
        assertTrue(t instanceof PrintKernelException, "期望 PrintKernelException，实际: " + t);
        assertEquals(PrintErrorCode.RENDER_TIMEOUT, ((PrintKernelException) t).getErrorCode(),
                "期望 RENDER_TIMEOUT，实际: " + ((PrintKernelException) t).getErrorCode());
    }

    @Test
    @DisplayName("H1: PdfRenderer 渲染入口中断抛 RENDER_TIMEOUT")
    void pdf_interruptAtRenderEntry() throws Exception {
        PdfRenderer renderer = new PdfRenderer(new BarcodeRenderer(), new PrintImageLoader());
        assertInterruptThrowsRenderTimeout(renderer, docTemplate(largeBody()));
    }

    @Test
    @DisplayName("H1: EscPosRenderer 渲染入口中断抛 RENDER_TIMEOUT")
    void escpos_interruptAtRenderEntry() throws Exception {
        EscPosRenderer renderer = new EscPosRenderer(
                new QrcodeRenderer(new BarcodeRenderer()), new PrintImageLoader(), initializedCjkRasterizer());
        assertInterruptThrowsRenderTimeout(renderer, receiptTemplate(largeBody()));
    }

    @Test
    @DisplayName("H1: TsplRenderer 渲染入口中断抛 RENDER_TIMEOUT")
    void tspl_interruptAtRenderEntry() throws Exception {
        TsplRenderer renderer = new TsplRenderer(new PrintImageLoader(), initializedCjkRasterizer());
        assertInterruptThrowsRenderTimeout(renderer, labelTemplate(largeBody()));
    }

    @Test
    @DisplayName("H1: CpclRenderer 渲染收尾后发现中断仍归因超时")
    void cpcl_interruptAfterLastElementMapsToTimeout() {
        Thread.currentThread().interrupt();
        try {
            CpclRenderer renderer = new CpclRenderer(
                    new InterruptAwareCjkRasterizer(false), new InterruptAfterLoadImageLoader());
            renderer.render(labelTemplate(Collections.singletonList(image("data:image/png;base64,"))),
                    RenderContext.builder().copies(1).build());
            throw new AssertionError("中断线程渲染未在返回前抛异常");
        } catch (PrintKernelException e) {
            assertEquals(PrintErrorCode.RENDER_TIMEOUT, e.getErrorCode());
        } finally {
            Thread.interrupted();
        }
    }

    @Test
    @DisplayName("H1: CpclRenderer 元素循环中断抛 RENDER_TIMEOUT")
    void cpcl_interruptAtElementBoundary() throws Exception {
        assertCpclInterruptMapsToTimeout(new InterruptAwareCjkRasterizer(false),
                Arrays.asList(text("字段 A"), text("字段 B")));
    }

    @Test
    @DisplayName("H1: CpclRenderer 中断优先于普通渲染异常映射")
    void cpcl_interruptIsNotMappedToRenderFailed() throws Exception {
        assertCpclInterruptMapsToTimeout(new InterruptAwareCjkRasterizer(true),
                Collections.singletonList(text("字段 A")));
    }

    @Test
    @DisplayName("H1: CpclRenderer 中断优先于业务异常")
    void cpcl_interruptPriorToBusinessException() throws Exception {
        CountDownLatch rasterizeEntered = new CountDownLatch(1);
        InterruptAwareCjkRasterizer adapter = new InterruptAwareCjkRasterizer(false) {
            @Override
            public BufferedImage rasterize(String text, int heightDots) {
                rasterizeEntered.countDown();
                try {
                    Thread.sleep(10_000L);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
                throw PrintKernelException.builder()
                        .errorCode(PrintErrorCode.UNSUPPORTED_ELEMENT)
                        .message("中断夹具业务异常")
                        .cause(new InterruptedException("中断后业务失败"))
                        .build();
            }

            @Override
            boolean awaitRasterizeEntered(long timeout, TimeUnit unit) throws InterruptedException {
                return rasterizeEntered.await(timeout, unit);
            }
        };
        assertCpclInterruptMapsToTimeout(adapter, new PrintImageLoader(),
                Collections.singletonList(text("字段 A")));
    }

    @Test
    @DisplayName("H1: PrintImageLoader 吞中断时 CPCL 不继续渲染")
    void cpcl_imageLoaderInterruptDoesNotContinueRender() throws Exception {
        InterruptAwareCjkRasterizer rasterizer = new InterruptAwareCjkRasterizer(false);
        PrintImageLoader imageLoader = new PrintImageLoader() {
            @Override
            public synchronized byte[] load(String src) {
                Thread.currentThread().interrupt();
                return null;
            }
        };
        assertCpclImageInterruptMapsToTimeout(imageLoader,
                Arrays.asList(image("http://example.test/interrupted.png"), text("字段 B")));
    }

    @Test
    @DisplayName("H1: PrintImageLoader 入口中断优先于 src 分发")
    void printImageLoader_interruptAtEntryMapsToTimeout() {
        PrintImageLoader imageLoader = new PrintImageLoader();
        Thread.currentThread().interrupt();
        try {
            imageLoader.load("file:///interrupted.png");
            throw new AssertionError("中断线程图片加载未在入口取消");
        } catch (PrintKernelException e) {
            assertEquals(PrintErrorCode.RENDER_TIMEOUT, e.getErrorCode());
        } finally {
            Thread.interrupted();
        }
    }

    private static class InterruptAwareCjkRasterizer extends CjkRasterizer {
        private final CountDownLatch rasterizeEntered = new CountDownLatch(1);
        private final boolean failAfterInterrupt;

        InterruptAwareCjkRasterizer(boolean failAfterInterrupt) {
            this.failAfterInterrupt = failAfterInterrupt;
        }

        boolean awaitRasterizeEntered(long timeout, TimeUnit unit) throws InterruptedException {
            return rasterizeEntered.await(timeout, unit);
        }

        @Override
        public BufferedImage rasterize(String text, int heightDots) {
            rasterizeEntered.countDown();
            try {
                Thread.sleep(10_000L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                if (failAfterInterrupt) {
                    throw new IllegalStateException("CPCL 栅格化夹具在中断后失败", e);
                }
            }
            return new BufferedImage(8, Math.max(8, heightDots), BufferedImage.TYPE_BYTE_BINARY);
        }
    }

    private static class InterruptAfterLoadImageLoader extends PrintImageLoader {
        @Override
        public synchronized byte[] load(String src) {
            Thread.currentThread().interrupt();
            return new byte[0];
        }
    }
}
