/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.core;

/**
 * Printer command set produced by a renderer.
 *
 * <p>Note: the device profile dialect column stores short names ({@code escpos})
 * while render results use the hyphenated form ({@code esc-pos}).</p>
 */
public enum CommandSet {

    PDF("pdf", "application/pdf"),
    ESC_POS("esc-pos", "application/octet-stream"),
    TSPL("tspl", "application/octet-stream"),
    ZPL("zpl", "application/octet-stream"),
    CPCL("cpcl", "application/octet-stream");

    private final String code;
    private final String defaultMimeType;

    CommandSet(String code, String defaultMimeType) {
        this.code = code;
        this.defaultMimeType = defaultMimeType;
    }

    public String getCode() {
        return code;
    }

    public String getDefaultMimeType() {
        return defaultMimeType;
    }

    /** Maps a device dialect short name to a command set; unknown names return null. */
    public static CommandSet fromDialect(String dialect) {
        if (dialect == null) {
            return null;
        }
        switch (dialect.trim().toLowerCase()) {
            case "escpos":
                return ESC_POS;
            case "tspl":
                return TSPL;
            case "zpl":
                return ZPL;
            case "cpcl":
                return CPCL;
            case "pdf":
                return PDF;
            default:
                return null;
        }
    }

    public static CommandSet of(String code) {
        if (code == null) {
            return null;
        }
        for (CommandSet cs : values()) {
            if (cs.code.equalsIgnoreCase(code)) {
                return cs;
            }
        }
        return fromDialect(code);
    }
}
