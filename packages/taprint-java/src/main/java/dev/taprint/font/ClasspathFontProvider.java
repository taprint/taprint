/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.font;

import java.awt.Font;
import java.io.IOException;
import java.io.InputStream;

/**
 * Default {@link FontProvider}: serves Noto Sans SC (OFL-1.1) from the
 * classpath {@code fonts/} directory. When the font file is absent the
 * provider reports {@link #available()} = false and renderers degrade to JDK
 * logical fonts / Helvetica.
 *
 * <p>The font file and its OFL.txt are not committed when the download step
 * could not run; see {@code src/main/resources/fonts/README.md} for how to
 * fetch them (they must ship unmodified, OFL.txt included).</p>
 */
public class ClasspathFontProvider implements FontProvider {

    /** Classpath location of the bundled Noto Sans SC regular face. */
    public static final String FONT_RESOURCE = "fonts/NotoSansSC-Regular.ttf";

    private final String resource;
    private final Font baseFont;

    public ClasspathFontProvider() {
        this(FONT_RESOURCE);
    }

    public ClasspathFontProvider(String resource) {
        this.resource = resource;
        this.baseFont = loadBaseFont(resource);
    }

    private static Font loadBaseFont(String resource) {
        try (InputStream in = ClasspathFontProvider.class.getClassLoader()
                .getResourceAsStream(resource)) {
            if (in == null) {
                return null;
            }
            return Font.createFont(Font.TRUETYPE_FONT, in);
        } catch (Exception e) {
            return null;
        }
    }

    @Override
    public Font baseFont() {
        return baseFont;
    }

    @Override
    public String pdfFontLocation() {
        return available() ? resource : null;
    }

    @Override
    public InputStream open() throws IOException {
        InputStream in = ClasspathFontProvider.class.getClassLoader()
                .getResourceAsStream(resource);
        if (in == null) {
            return null;
        }
        return in;
    }

    @Override
    public boolean available() {
        return baseFont != null;
    }
}
