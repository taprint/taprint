/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.font;

import java.awt.Font;
import java.io.IOException;
import java.io.InputStream;

/**
 * Font SPI (ADR-0002): every renderer that needs a CJK typeface obtains it
 * through this interface; no renderer loads font files directly.
 *
 * <p>The bundled default is Noto Sans SC (OFL-1.1) served from the classpath
 * {@code fonts/} directory by {@link ClasspathFontProvider}. Hosts can supply
 * any redistributable font (or a system font source) by implementing this
 * interface. Fonts whose license forbids redistribution must never be shipped
 * with the kernel.</p>
 */
public interface FontProvider {

    /**
     * Base AWT font for rasterization (CJK bitmap channel of the TSPL/CPCL
     * renderers and the preview simulator). Callers derive sizes from it.
     *
     * @return base font, or null when no CJK font is available (callers fall
     *         back to a JDK logical font)
     */
    Font baseFont();

    /**
     * Location string consumable by OpenPDF's {@code BaseFont.createFont} for
     * PDF embedding (classpath path, optionally with a face index such as
     * {@code fonts/NotoSansSC-Regular.ttf,0}).
     *
     * @return font location, or null when no font is available (callers fall
     *         back to Helvetica and CJK glyphs will be missing)
     */
    String pdfFontLocation();

    /**
     * Opens the raw font bytes (for hosts that embed fonts themselves).
     *
     * @return stream of the font file; null when unavailable
     * @throws IOException when the font exists but cannot be read
     */
    InputStream open() throws IOException;

    /** @return true when a real CJK font is available behind this provider */
    boolean available();
}
