/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.render.core;

import dev.taprint.core.CommandSet;
import dev.taprint.core.DeviceClass;
import dev.taprint.dsl.PageSpec;
import dev.taprint.renderer.EvaluatedElement;
import dev.taprint.renderer.EvaluatedTemplate;

import java.util.ArrayList;
import java.util.List;

/**
 * Structural frame outline for the {@code meta.frameSummary[]} field — same
 * meta shape as the MCP compile response (schema/render-api.json). Lines
 * describe the emitted frame order (header, one line per element, trailer);
 * byte-level goldens live under fixtures/, not in this summary.
 */
public final class FrameSummary {

    private static final int CONTENT_PREVIEW_CHARS = 24;

    private FrameSummary() {
    }

    public static List<String> build(DeviceClass deviceClass, EvaluatedTemplate evaluated,
                                     CommandSet commandSet, int copies, Integer dpi) {
        return switch (deviceClass) {
            case RECEIPT -> receiptSummary(evaluated, commandSet);
            case LABEL -> labelSummary(evaluated, commandSet, copies, dpi);
            default -> List.of("UNSUPPORTED " + deviceClass);
        };
    }

    private static List<String> receiptSummary(EvaluatedTemplate evaluated, CommandSet commandSet) {
        List<String> out = new ArrayList<>();
        out.add("INIT");
        for (EvaluatedElement el : elements(evaluated)) {
            switch (safeType(el)) {
                case "text" -> out.add("TEXT \"" + preview(el.getText()) + "\"");
                case "barcode" -> out.add("BARCODE " + str(el.getSymbology(), "CODE128")
                        + " \"" + preview(el.getText()) + "\"");
                case "qrcode" -> out.add("QRCODE \"" + preview(el.getText()) + "\"");
                case "image" -> out.add("IMAGE");
                case "table" -> out.add("TABLE rows=" + rowCount(el));
                case "kvtable" -> out.add("KVTABLE rows=" + kvRowCount(el));
                case "line" -> out.add("LINE");
                case "rect" -> out.add("RECT");
                case "spacer" -> out.add("SPACER");
                case "pageBreak" -> out.add("PAGE_BREAK");
                case "cut" -> out.add(el.getPartial() != null && el.getPartial() ? "CUT partial" : "CUT");
                case "cashDrawer" -> out.add("CASH_DRAWER");
                default -> out.add(safeType(el).toUpperCase());
            }
        }
        out.add("END " + commandSet.getCode());
        return out;
    }

    private static List<String> labelSummary(EvaluatedTemplate evaluated, CommandSet commandSet,
                                             int copies, Integer dpi) {
        List<String> out = new ArrayList<>();
        if (evaluated.getLabel() != null) {
            PageSpec size = evaluated.getLabel().getSize();
            if (size != null) {
                out.add("SIZE " + str(size.getWidth(), "?") + "," + str(size.getHeight(), "?"));
            }
            out.add("GAP " + str(evaluated.getLabel().getGap(), "2mm"));
        }
        if (dpi != null) {
            out.add("DPI " + dpi);
        }
        out.add("CLS");
        for (EvaluatedElement el : elements(evaluated)) {
            switch (safeType(el)) {
                case "text" -> out.add("T " + str(el.getX(), "0") + "," + str(el.getY(), "0")
                        + " \"" + preview(el.getText()) + "\"");
                case "barcode" -> out.add("B " + str(el.getX(), "0") + "," + str(el.getY(), "0")
                        + " " + str(el.getSymbology(), "CODE128"));
                case "qrcode" -> out.add("Q " + str(el.getX(), "0") + "," + str(el.getY(), "0")
                        + " unit=" + (el.getSize() == null ? 4 : el.getSize()));
                case "image" -> out.add("IMG " + str(el.getX(), "0") + "," + str(el.getY(), "0"));
                case "line" -> out.add("L " + str(el.getX(), "0") + "," + str(el.getY(), "0"));
                case "box" -> out.add("BOX " + str(el.getX(), "0") + "," + str(el.getY(), "0")
                        + "," + str(el.getWidth(), "0") + "," + str(el.getHeight(), "0"));
                default -> out.add(safeType(el).toUpperCase());
            }
        }
        out.add("PRINT " + Math.max(1, copies));
        return out;
    }

    private static List<EvaluatedElement> elements(EvaluatedTemplate evaluated) {
        List<EvaluatedElement> body = evaluated.getBody();
        return body == null ? List.of() : body;
    }

    private static String safeType(EvaluatedElement el) {
        return el.getType() == null ? "unknown" : el.getType();
    }

    private static int rowCount(EvaluatedElement el) {
        return el.getRows() == null ? 0 : el.getRows().size();
    }

    private static int kvRowCount(EvaluatedElement el) {
        return el.getKvRows() == null ? 0 : el.getKvRows().size();
    }

    private static String preview(String text) {
        if (text == null) {
            return "";
        }
        return text.length() <= CONTENT_PREVIEW_CHARS ? text
                : text.substring(0, CONTENT_PREVIEW_CHARS) + "…";
    }

    private static String str(String value, String fallback) {
        return value == null ? fallback : value;
    }
}
