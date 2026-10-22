/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.font;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.awt.Font;

/**
 * Preview simulator fonts: derives sized faces from the shared
 * {@link FontProvider} SPI so previews and renderers use the same typeface.
 */
public class PreviewFonts {

    private static final Logger log = LoggerFactory.getLogger(PreviewFonts.class);

    private final FontProvider fontProvider;
    private final Font baseFont;

    public PreviewFonts() {
        this(new ClasspathFontProvider());
    }

    public PreviewFonts(FontProvider fontProvider) {
        this.fontProvider = fontProvider;
        Font font = fontProvider == null ? null : fontProvider.baseFont();
        if (font == null) {
            log.warn("No preview font provided; degrading to the JDK logical font");
            font = new Font("Serif", Font.PLAIN, 12);
        }
        this.baseFont = font;
    }

    public Font ofSize(float px) {
        return baseFont.deriveFont(px);
    }

    public Font ofSize(float px, boolean bold) {
        return baseFont.deriveFont(bold ? Font.BOLD : Font.PLAIN, px);
    }

    /** True when a real CJK font backs this holder. */
    public boolean hasFont() {
        return fontProvider != null && fontProvider.available();
    }
}
