/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint;

import dev.taprint.barcode.BarcodeRenderer;
import dev.taprint.font.ClasspathFontProvider;
import dev.taprint.font.FontProvider;
import dev.taprint.renderer.CjkRasterizer;
import dev.taprint.renderer.PdfRenderer;
import dev.taprint.renderer.PrintImageLoader;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.awt.Font;
import java.awt.image.BufferedImage;
import java.io.InputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * FontProvider SPI behavior (ADR-0002): the bundled classpath provider serves
 * Noto Sans SC when present, and renderers degrade instead of failing when a
 * provider has no font.
 */
class FontProviderTest {

    @Test
    @DisplayName("bundled provider serves the Noto Sans SC classpath font")
    void test_bundledProvider() throws Exception {
        ClasspathFontProvider provider = new ClasspathFontProvider();
        assumeTrue(provider.available(), "bundled font not fetched - see fonts/README.md");
        Font base = provider.baseFont();
        assertNotNull(base);
        assertTrue(base.getFamily().contains("Noto Sans SC"), base.getFamily());
        assertEquals("fonts/NotoSansSC-Regular.ttf", provider.pdfFontLocation());
        try (InputStream in = provider.open()) {
            assertNotNull(in);
            assertTrue(in.read() >= 0);
        }
    }

    @Test
    @DisplayName("CJK rasterizer degrades to a logical font when no font is provided")
    void test_rasterizerDegradation() {
        FontProvider empty = new FontProvider() {
            @Override
            public Font baseFont() {
                return null;
            }

            @Override
            public String pdfFontLocation() {
                return null;
            }

            @Override
            public InputStream open() {
                return null;
            }

            @Override
            public boolean available() {
                return false;
            }
        };
        CjkRasterizer rasterizer = new CjkRasterizer(empty);
        assertEquals(false, rasterizer.hasFont());
        BufferedImage img = rasterizer.rasterize("你好", 24);
        assertTrue(img.getWidth() > 0 && img.getHeight() > 0);
    }

    @Test
    @DisplayName("PDF renderer reports font availability through the SPI")
    void test_pdfRendererFontFlag() {
        PdfRenderer withFont = new PdfRenderer(new BarcodeRenderer(), new PrintImageLoader(),
                new ClasspathFontProvider());
        assumeTrue(withFont.hasFont(), "bundled font not fetched - see fonts/README.md");

        FontProvider empty = new FontProvider() {
            @Override
            public Font baseFont() {
                return null;
            }

            @Override
            public String pdfFontLocation() {
                return null;
            }

            @Override
            public InputStream open() {
                return null;
            }

            @Override
            public boolean available() {
                return false;
            }
        };
        PdfRenderer degraded = new PdfRenderer(new BarcodeRenderer(), new PrintImageLoader(), empty);
        assertEquals(false, degraded.hasFont());
    }
}
