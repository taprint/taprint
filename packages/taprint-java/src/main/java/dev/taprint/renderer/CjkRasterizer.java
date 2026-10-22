/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.renderer;

import dev.taprint.font.FontProvider;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.awt.Color;
import java.awt.Font;
import java.awt.FontMetrics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import javax.imageio.ImageIO;

/**
 * CJK text rasterizer (bitmap channel for TSPL/CPCL printers without a
 * built-in CJK typeface).
 *
 * <p>Fonts come from the {@link FontProvider} SPI (ADR-0002); when the
 * provider has no font available, rendering degrades to a JDK logical font.</p>
 */
public class CjkRasterizer {

    private static final Logger log = LoggerFactory.getLogger(CjkRasterizer.class);

    private final FontProvider fontProvider;
    private final Font baseFont;

    public CjkRasterizer() {
        this(new dev.taprint.font.ClasspathFontProvider());
    }

    public CjkRasterizer(FontProvider fontProvider) {
        this.fontProvider = fontProvider;
        Font font = fontProvider == null ? null : fontProvider.baseFont();
        if (font == null) {
            log.warn("No CJK font provided; rasterization degrades to the JDK logical font");
            font = new Font("Serif", Font.PLAIN, 24);
        }
        this.baseFont = font;
    }

    /** Font source in use (SPI). */
    public FontProvider fontProvider() {
        return fontProvider;
    }

    /** True when a real CJK font backs this rasterizer. */
    public boolean hasFont() {
        return fontProvider != null && fontProvider.available();
    }

    /**
     * Text to a monochrome bitmap (black text on white).
     *
     * @param text       single-line text
     * @param heightDots target glyph height (dots/pixels)
     */
    public BufferedImage rasterize(String text, int heightDots) {
        int h = Math.max(8, heightDots);
        Font font = baseFont.deriveFont((float) (h * 0.9));
        BufferedImage probe = new BufferedImage(1, 1, BufferedImage.TYPE_BYTE_BINARY);
        Graphics2D pg = probe.createGraphics();
        pg.setFont(font);
        FontMetrics fm = pg.getFontMetrics();
        int w = Math.max(8, fm.stringWidth(text) + 4);
        pg.dispose();

        BufferedImage image = new BufferedImage(w, h, BufferedImage.TYPE_BYTE_BINARY);
        Graphics2D g = image.createGraphics();
        try {
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_OFF);
            g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_OFF);
            g.setColor(Color.WHITE);
            g.fillRect(0, 0, w, h);
            g.setColor(Color.BLACK);
            g.setFont(font);
            FontMetrics m = g.getFontMetrics();
            g.drawString(text, 0, (h - m.getHeight()) / 2 + m.getAscent());
        } finally {
            g.dispose();
        }
        return image;
    }

    /**
     * Decodes arbitrary image bytes (PNG/JPEG and other ImageIO formats).
     *
     * @param bytes image bytes
     * @return decoded image; null on failure (callers skip, rendering continues)
     */
    public BufferedImage decode(byte[] bytes) {
        if (bytes == null || bytes.length == 0) {
            return null;
        }
        try {
            return ImageIO.read(new ByteArrayInputStream(bytes));
        } catch (Exception e) {
            log.warn("Image decoding failed: {}", e.getMessage());
            return null;
        }
    }

    /**
     * Binarizing rescale for label images (shared by the TSPL BITMAP and the
     * CPCL EG channels). Proportional scale to the target height with an
     * optional width cap; the returned image is white background/black
     * content and is binarized later by {@link MonochromeBitmapUtil} with the
     * same threshold used for CJK text bitmaps.
     *
     * @param src              source image
     * @param targetHeightDots target height (dots/pixels), at least 1
     * @param maxWidthDots     target width cap (dots); &lt;=0 means unlimited
     * @return rescaled white-background image
     */
    public BufferedImage rasterizeImage(BufferedImage src, int targetHeightDots, int maxWidthDots) {
        int srcW = src.getWidth();
        int srcH = src.getHeight();
        if (srcW <= 0 || srcH <= 0) {
            return src;
        }
        int h = Math.max(1, targetHeightDots);
        double scale = (double) h / srcH;
        if (maxWidthDots > 0 && srcW * scale > maxWidthDots) {
            scale = (double) maxWidthDots / srcW;
        }
        int tw = Math.max(1, (int) Math.round(srcW * scale));
        int th = Math.max(1, (int) Math.round(srcH * scale));
        BufferedImage image = new BufferedImage(tw, th, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = image.createGraphics();
        try {
            g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
            g.setColor(Color.WHITE);
            g.fillRect(0, 0, tw, th);
            g.setColor(Color.BLACK);
            g.drawImage(src, 0, 0, tw, th, null);
        } finally {
            g.dispose();
        }
        return image;
    }

    /** Binarizing rescale by target height only, no width cap. */
    public BufferedImage rasterizeImage(BufferedImage src, int targetHeightDots) {
        return rasterizeImage(src, targetHeightDots, 0);
    }
}
