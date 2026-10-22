/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.renderer;

import dev.taprint.core.PrintKernelException;
import dev.taprint.barcode.BarcodeRenderer;
import dev.taprint.barcode.Symbology;
import dev.taprint.dsl.DocPresentation;
import dev.taprint.dsl.Nup;
import dev.taprint.dsl.PageSpec;
import dev.taprint.dsl.TableColumn;
import dev.taprint.core.CommandSet;
import dev.taprint.core.PrintErrorCode;
import java.awt.Color;
import com.lowagie.text.Document;
import com.lowagie.text.Element;
import com.lowagie.text.Font;
import com.lowagie.text.Image;
import com.lowagie.text.Paragraph;
import com.lowagie.text.Phrase;
import com.lowagie.text.Rectangle;
import com.lowagie.text.pdf.BaseFont;
import com.lowagie.text.pdf.ColumnText;
import com.lowagie.text.pdf.PdfPCell;
import com.lowagie.text.pdf.PdfPTable;
import com.lowagie.text.pdf.PdfPageEventHelper;
import com.lowagie.text.pdf.PdfTemplate;
import com.lowagie.text.pdf.PdfWriter;
import com.lowagie.text.pdf.draw.LineSeparator;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * A4 document PDF renderer (OpenPDF).
 *
 * <p>The CJK typeface comes from the {@link dev.taprint.font.FontProvider}
 * SPI (ADR-0002) and is embedded subsetted; when no font is available the
 * renderer degrades to Helvetica (CJK glyphs will be missing). Footers are
 * drawn by a page event in the bottom margin of every page.</p>
 */
public class PdfRenderer implements Renderer {

    private static final Logger log = LoggerFactory.getLogger(PdfRenderer.class);
    private static final float DEFAULT_FONT_SIZE = 10.5f;

    private final BarcodeRenderer barcodeRenderer;
    private final PrintImageLoader imageLoader;
    private final dev.taprint.font.FontProvider fontProvider;

    private BaseFont cjkBaseFont;

    public PdfRenderer(BarcodeRenderer barcodeRenderer, PrintImageLoader imageLoader) {
        this(barcodeRenderer, imageLoader, new dev.taprint.font.ClasspathFontProvider());
    }

    public PdfRenderer(BarcodeRenderer barcodeRenderer, PrintImageLoader imageLoader,
                       dev.taprint.font.FontProvider fontProvider) {
        this.barcodeRenderer = barcodeRenderer;
        this.imageLoader = imageLoader;
        this.fontProvider = fontProvider;
        init();
    }

    /** True when a real CJK font backs this renderer. */
    public boolean hasFont() {
        return fontProvider != null && fontProvider.available();
    }

    private void init() {
        String location = fontProvider == null ? null : fontProvider.pdfFontLocation();
        if (location != null) {
            try {
                cjkBaseFont = BaseFont.createFont(location, BaseFont.IDENTITY_H, BaseFont.EMBEDDED);
                return;
            } catch (Exception e) {
                log.error("PDF CJK font load failed, degrading to Helvetica (CJK glyphs missing): {}",
                        e.getMessage());
            }
        }
        try {
            cjkBaseFont = BaseFont.createFont(BaseFont.HELVETICA, BaseFont.WINANSI, BaseFont.NOT_EMBEDDED);
        } catch (Exception ex) {
            throw new IllegalStateException("PDF base font unavailable", ex);
        }
    }

    @Override
    public CommandSet getCommandSet() {
        return CommandSet.PDF;
    }

    @Override
    public RenderResult render(EvaluatedTemplate evaluated, RenderContext ctx) {
        checkInterrupted();
        DocPresentation spec = evaluated.getDoc();
        if (spec == null) {
            throw PrintKernelException.builder()
                    .errorCode(PrintErrorCode.UNSUPPORTED_DEVICE_CLASS)
                    .message("模板无 doc 呈现")
                    .build();
        }
        ByteArrayOutputStream baos = new ByteArrayOutputStream(64 * 1024);
        try {
            Document doc = new Document();
            PdfWriter writer = PdfWriter.getInstance(doc, baos);
            Rectangle page = toRectangle(spec.getPage());
            doc.setPageSize(page);
            float[] margins = toMargins(spec.getPage());

            List<Element> footerElements = buildElements(spec, evaluated.getFooter());
            float footerHeight = estimateHeight(footerElements);
            if (footerHeight > 0) {
                margins[2] += footerHeight + 8;
            }
            // 页面事件：水印（底层）+ 页脚（边距区），每页 onEndPage 统一绘制
            boolean hasFooter = footerHeight > 0;
            boolean hasWatermark = evaluated.getWatermark() != null;
            if (hasFooter || hasWatermark) {
                writer.setPageEvent(new DocPageEvent(
                        hasFooter ? footerElements : null, hasFooter ? footerHeight : 0,
                        evaluated.getWatermark()));
            }
            doc.setMargins(margins[0], margins[1], margins[3], margins[2]);
            doc.open();

            Nup nup = spec.getPage() == null ? null : spec.getPage().getNup();
            int copies = Math.max(1, ctx.getCopies());
            if (nup != null && nup.getCols() != null && nup.getRows() != null
                    && nup.getCols() > 0 && nup.getRows() > 0) {
                renderNup(doc, writer, spec, evaluated, nup, copies);
            } else {
                for (int c = 0; c < copies; c++) {
                    if (c > 0) {
                        doc.newPage();
                    }
                    renderElements(doc, buildElements(spec, evaluated.getHeader()));
                    renderElements(doc, buildElements(spec, evaluated.getBody()));
                }
            }
            doc.close();
            return new RenderResult(baos.toByteArray(), "application/pdf", CommandSet.PDF);
        } catch (PrintKernelException e) {
            throw e;
        } catch (Exception e) {
            throw PrintKernelException.builder()
                    .errorCode(PrintErrorCode.RENDER_FAILED)
                    .message("PDF 渲染失败: " + e.getMessage())
                    .cause(e)
                    .build();
        }
    }

    /**
     * nup 一页多单（v2.0）：单据内容渲染为 PdfTemplate（XObject），
     * 按 cols×rows 网格逐格放置；gap 换算 pt。每份物理页重复同一网格
     * （copies 控制物理页数）。
     *
     * <p>单元格内容超出容量时截断并告警（nup 场景为小票面单，设计态保证适配）。
     */
    private void renderNup(Document doc, PdfWriter writer, DocPresentation spec,
                           EvaluatedTemplate evaluated, Nup nup, int copies) throws Exception {
        float pageW = doc.getPageSize().getWidth();
        float pageH = doc.getPageSize().getHeight();
        float gap = LengthUtil.mmToPoints(nup.getGap(), 0);
        float left = doc.leftMargin();
        float right = doc.rightMargin();
        float top = doc.topMargin();
        float bottom = doc.bottomMargin();
        float gridW = pageW - left - right;
        float gridH = pageH - top - bottom;
        int cols = Math.min(4, Math.max(1, nup.getCols()));
        int rows = Math.min(4, Math.max(1, nup.getRows()));
        float cellW = (gridW - gap * (cols - 1)) / cols;
        float cellH = (gridH - gap * (rows - 1)) / rows;

        // 单据内容渲染为 XObject（header + body）
        PdfTemplate tpl = writer.getDirectContent().createTemplate(cellW, cellH);
        ColumnText ct = new ColumnText(tpl);
        ct.setSimpleColumn(0, 0, cellW, cellH);
        List<Element> ticketElements = new ArrayList<>();
        ticketElements.addAll(buildElements(spec, evaluated.getHeader()));
        ticketElements.addAll(buildElements(spec, evaluated.getBody()));
        for (Element element : ticketElements) {
            checkInterrupted();
            ct.addElement(element);
        }
        // 内部状态，模拟后再调 go() 渲染不出任何内容（XObject 恒为空）。
        // 正确口径：直接真实渲染 go()，以返回 status 判断溢出（超出部分留在 ct 不渲染=截断）
        int status = ct.go();
        if (ColumnText.hasMoreText(status)) {
            log.warn("nup 单元格内容超出容量，超出部分截断（cols={} rows={}）", cols, rows);
        }

        Image cellImage = Image.getInstance(tpl);
        for (int c = 0; c < copies; c++) {
            if (c > 0) {
                doc.newPage();
            }
            for (int r = 0; r < rows; r++) {
                for (int col = 0; col < cols; col++) {
                    float x = left + col * (cellW + gap);
                    float y = pageH - top - (r + 1) * cellH - r * gap;
                    Image placed = Image.getInstance(cellImage);
                    placed.setAbsolutePosition(x, y);
                    doc.add(placed);
                }
            }
        }
    }

    /** EvaluatedElement → OpenPDF 流式元素 */
    private List<Element> buildElements(DocPresentation spec, List<EvaluatedElement> elements) throws Exception {
        List<Element> result = new ArrayList<>();
        if (elements == null) {
            return result;
        }
        for (EvaluatedElement el : elements) {
            checkInterrupted();
            buildElement(spec, el, result);
        }
        return result;
    }

    private void buildElement(DocPresentation spec, EvaluatedElement el, List<Element> out) throws Exception {
        String type = el.getType();
        if (type == null) {
            return;
        }
        switch (type) {
            case "text":
                out.add(buildText(el));
                break;
            case "image":
                Image img = buildImage(el);
                if (img != null) {
                    out.add(img);
                }
                break;
            case "table":
                out.add(buildTable(el));
                out.add(spacing(4));
                break;
            case "kvtable":
                out.add(buildKvTable(el));
                out.add(spacing(4));
                break;
            case "barcode":
            case "qrcode":
                Image code = buildCode(el);
                if (code != null) {
                    out.add(code);
                }
                break;
            case "line":
                LineSeparator ls = new LineSeparator();
                ls.setLineWidth(0.5f);
                out.add(new Paragraph(new com.lowagie.text.Chunk(ls)));
                break;
            case "rect":
                out.add(buildRect(el));
                out.add(spacing(4));
                break;
            case "spacer":
                out.add(spacing(LengthUtil.mmToPoints(el.getHeight(), 5)));
                break;
            case "pageBreak":
                out.add(new Paragraph(com.lowagie.text.Chunk.NEXTPAGE));
                break;
            default:
                log.debug("doc 呈现忽略元素类型: {}", type);
        }
    }

    private Paragraph buildText(EvaluatedElement el) {
        Font font = toFont(el.getStyle());
        Paragraph p = new Paragraph(el.getText() == null ? "" : el.getText(), font);
        p.setAlignment(toAlignment(el.getAlign() != null ? el.getAlign() : styleAlign(el)));
        if (el.getMargin() != null) {
            p.setSpacingBefore(LengthUtil.mmToPoints(el.getMargin().getTop(), 0));
            p.setSpacingAfter(LengthUtil.mmToPoints(el.getMargin().getBottom(), 0));
        }
        // v2.0 style 盒模型：text 段落带边框/背景色时包一层单格表格实现
        dev.taprint.dsl.DslStyle style = el.getStyle();
        boolean hasBorder = style != null && style.getBorder() != null;
        boolean hasBg = style != null && style.getBackgroundColor() != null;
        boolean hasPadding = style != null && style.getPadding() != null;
        if (hasBorder || hasBg || hasPadding) {
            PdfPTable box = new PdfPTable(1);
            box.setWidthPercentage(100);
            PdfPCell cell = new PdfPCell(p);
            applyBoxStyle(cell, style);
            box.addCell(cell);
            Paragraph wrapper = new Paragraph();
            wrapper.add(box);
            if (el.getMargin() != null) {
                wrapper.setSpacingBefore(LengthUtil.mmToPoints(el.getMargin().getTop(), 0));
                wrapper.setSpacingAfter(LengthUtil.mmToPoints(el.getMargin().getBottom(), 0));
            }
            return wrapper;
        }
        return p;
    }

    /**
     * rect 元素（v2.0 渲染落地，v1.0 即合法类型）：边框矩形块。
     * 用单格 PdfPTable 承载边框/背景/内边距，高度按 height 声明（缺省一行文字高）。
     */
    private PdfPTable buildRect(EvaluatedElement el) {
        PdfPTable table = new PdfPTable(1);
        table.setWidthPercentage(el.getWidth() == null ? 100f
                : (float) Math.max(1, Math.min(100, LengthUtil.parsePercent(el.getWidth()))));
        PdfPCell cell = new PdfPCell();
        float height = LengthUtil.mmToPoints(el.getHeight(), 0);
        if (height > 0) {
            cell.setFixedHeight(height);
        } else {
            cell.setMinimumHeight(DEFAULT_FONT_SIZE * 1.4f);
        }
        dev.taprint.dsl.DslStyle style = el.getStyle();
        dev.taprint.dsl.BoxEdges border =
                el.getBorder() != null ? el.getBorder() : (style == null ? null : style.getBorder());
        if (border != null) {
            applyBoxStyle(cell, style, border, style == null ? null : style.getPadding(),
                    style == null ? null : style.getBackgroundColor());
        } else {
            applyBoxStyle(cell, style);
        }
        cell.setPhrase(new Phrase(" ", new Font(cjkBaseFont, DEFAULT_FONT_SIZE)));
        table.addCell(cell);
        return table;
    }

    /** 单元格盒模型应用：border/padding/backgroundColor（style 提供缺省 border） */
    private void applyBoxStyle(PdfPCell cell, dev.taprint.dsl.DslStyle style) {
        if (style == null) {
            return;
        }
        applyBoxStyle(cell, style, style.getBorder(), style.getPadding(), style.getBackgroundColor());
    }

    private void applyBoxStyle(PdfPCell cell, dev.taprint.dsl.DslStyle style,
                               dev.taprint.dsl.BoxEdges border,
                               dev.taprint.dsl.BoxEdges padding,
                               String backgroundColor) {
        if (border != null) {
            // 任一边声明 → 关闭默认全边框，逐边按声明设置
            boolean any = border.getTop() != null || border.getRight() != null
                    || border.getBottom() != null || border.getLeft() != null;
            if (any) {
                cell.setBorder(com.lowagie.text.Rectangle.NO_BORDER);
                float topW = borderWidthPt(border.getTop());
                float rightW = borderWidthPt(border.getRight());
                float bottomW = borderWidthPt(border.getBottom());
                float leftW = borderWidthPt(border.getLeft());
                int mask = 0;
                if (topW > 0) {
                    mask |= com.lowagie.text.Rectangle.TOP;
                    cell.setBorderWidthTop(topW);
                }
                if (rightW > 0) {
                    mask |= com.lowagie.text.Rectangle.RIGHT;
                    cell.setBorderWidthRight(rightW);
                }
                if (bottomW > 0) {
                    mask |= com.lowagie.text.Rectangle.BOTTOM;
                    cell.setBorderWidthBottom(bottomW);
                }
                if (leftW > 0) {
                    mask |= com.lowagie.text.Rectangle.LEFT;
                    cell.setBorderWidthLeft(leftW);
                }
                cell.setBorder(mask);
            }
        }
        if (padding != null) {
            cell.setPaddingTop(LengthUtil.mmToPoints(padding.getTop(), cell.getPaddingTop()));
            cell.setPaddingRight(LengthUtil.mmToPoints(padding.getRight(), cell.getPaddingRight()));
            cell.setPaddingBottom(LengthUtil.mmToPoints(padding.getBottom(), cell.getPaddingBottom()));
            cell.setPaddingLeft(LengthUtil.mmToPoints(padding.getLeft(), cell.getPaddingLeft()));
        }
        if (backgroundColor != null) {
            Color bg = parseColor(backgroundColor, null);
            if (bg != null) {
                cell.setBackgroundColor(bg);
            }
        }
        if (style != null && style.getAlign() != null) {
            cell.setHorizontalAlignment(toAlignment(style.getAlign()));
        }
    }

    /** border 边宽：length → pt；缺省 0.5pt（声明了边但无数值时给可见细线） */
    private float borderWidthPt(String edge) {
        if (edge == null || edge.trim().isEmpty()) {
            return 0;
        }
        float pt = LengthUtil.mmToPoints(edge, 0);
        return pt > 0 ? pt : 0.5f;
    }

    private String styleAlign(EvaluatedElement el) {
        return el.getStyle() != null ? el.getStyle().getAlign() : null;
    }

    private Image buildImage(EvaluatedElement el) throws Exception {
        byte[] bytes = imageLoader.load(el.getText());
        if (bytes == null) {
            return null;
        }
        Image img = Image.getInstance(bytes);
        float width = LengthUtil.mmToPoints(el.getWidth(), 30);
        float height = LengthUtil.mmToPoints(el.getHeight(), width * img.getHeight() / img.getWidth());
        img.scaleToFit(width, height);
        img.setAlignment(toAlignment(el.getAlign()));
        return img;
    }

    private PdfPTable buildTable(EvaluatedElement el) throws Exception {
        List<TableColumn> cols = el.getColumns();
        int colCount = cols.size();
        PdfPTable table = new PdfPTable(colCount);
        table.setWidthPercentage(100);
        float[] widths = relativeWidths(cols);
        if (widths != null) {
            table.setWidths(widths);
        }
        Font headerFont = new Font(cjkBaseFont, DEFAULT_FONT_SIZE, Font.BOLD);
        Font cellFont = new Font(cjkBaseFont, DEFAULT_FONT_SIZE, Font.NORMAL);
        Font boldFont = new Font(cjkBaseFont, DEFAULT_FONT_SIZE, Font.BOLD);

        // ---- 表头（v2 headerGrid 多级表头优先；缺省回退 headers 单行表头） ----
        int headerRowCount = 0;
        if (el.getHeaderGrid() != null && !el.getHeaderGrid().isEmpty()) {
            headerRowCount = el.getHeaderGrid().size();
            for (List<EvaluatedElement.EvaluatedHeaderCell> row : el.getHeaderGrid()) {
                for (EvaluatedElement.EvaluatedHeaderCell hc : row) {
                    PdfPCell cell = new PdfPCell(new Phrase(
                            hc.getText() == null ? "" : hc.getText(), headerFont));
                    if (hc.getColspan() != null && hc.getColspan() > 1) {
                        cell.setColspan(hc.getColspan());
                    }
                    if (hc.getRowspan() != null && hc.getRowspan() > 1) {
                        cell.setRowspan(hc.getRowspan());
                    }
                    cell.setBackgroundColor(new Color(0xF2, 0xF2, 0xF2));
                    cell.setHorizontalAlignment(toAlignment(
                            hc.getAlign() != null ? hc.getAlign() : "center"));
                    cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                    cell.setPadding(3f);
                    if (hc.getDiagonal() != null && !hc.getDiagonal().isEmpty()) {
                        cell.setCellEvent(new DiagonalHeaderEvent(hc));
                    }
                    applyBoxStyle(cell, hc.getStyle());
                    table.addCell(cell);
                }
            }
        } else if (el.getHeaders() != null) {
            headerRowCount = 1;
            for (String header : el.getHeaders()) {
                PdfPCell cell = new PdfPCell(new Phrase(header == null ? "" : header, headerFont));
                cell.setBackgroundColor(new Color(0xF2, 0xF2, 0xF2));
                cell.setHorizontalAlignment(Element.ALIGN_CENTER);
                cell.setPadding(3f);
                table.addCell(cell);
            }
        }

        // ---- 数据行 ----
        // detailRowIndex：跨组的全局明细行下标，与求值层 rowSubtables 的顺序严格对齐
        int detailRowIndex = 0;
        if (el.getGroupBlocks() != null && !el.getGroupBlocks().isEmpty()) {
            // 分组：组头合并行 + 组内明细行 + 小计行
            for (EvaluatedElement.EvaluatedGroupBlock block : el.getGroupBlocks()) {
                if (block.getHeaderText() != null) {
                    PdfPCell gh = new PdfPCell(new Phrase(block.getHeaderText(), boldFont));
                    gh.setColspan(colCount);
                    gh.setBackgroundColor(new Color(0xE8, 0xE8, 0xE8));
                    gh.setPadding(3f);
                    table.addCell(gh);
                }
                if (block.getRows() != null) {
                    for (List<String> row : block.getRows()) {
                        addDetailRow(table, row, cols, cellFont, el, detailRowIndex);
                        detailRowIndex++;
                    }
                }
                if (block.getSubtotalValues() != null) {
                    // 小计行：label 占首列区，values 逐列对齐（null 留空）
                    List<String> values = block.getSubtotalValues();
                    // label 单元格占 values 中首个 null 段（连续 null 前缀）的列数
                    int nullPrefix = 0;
                    while (nullPrefix < values.size() && values.get(nullPrefix) == null) {
                        nullPrefix++;
                    }
                    int labelSpan = Math.max(1, nullPrefix);
                    PdfPCell labelCell = new PdfPCell(new Phrase(
                            block.getSubtotalLabel() == null ? "" : block.getSubtotalLabel(), boldFont));
                    labelCell.setColspan(labelSpan);
                    labelCell.setHorizontalAlignment(Element.ALIGN_RIGHT);
                    labelCell.setPadding(3f);
                    table.addCell(labelCell);
                    for (int i = nullPrefix; i < values.size(); i++) {
                        String v = values.get(i);
                        PdfPCell vc = new PdfPCell(new Phrase(v == null ? "" : v, boldFont));
                        vc.setHorizontalAlignment(i < cols.size()
                                ? toAlignment(cols.get(i).getAlign()) : Element.ALIGN_LEFT);
                        vc.setPadding(3f);
                        table.addCell(vc);
                    }
                    // values 数量可能小于列数：补齐空单元格
                    for (int i = values.size(); i < colCount - labelSpan; i++) {
                        table.addCell(new PdfPCell(new Phrase("", boldFont)));
                    }
                }
            }
        } else if (el.getRows() != null) {
            // staticRows position=before：静态行在数据行前
            if (el.getStaticRowCells() != null && "before".equals(el.getStaticRowCells().getPosition())) {
                addStaticRows(table, el.getStaticRowCells(), colCount, cellFont);
            }
            for (List<String> row : el.getRows()) {
                addDetailRow(table, row, cols, cellFont, el, detailRowIndex);
                detailRowIndex++;
            }
        }
        // staticRows position=after（缺省）：数据行后
        if (el.getStaticRowCells() != null && !"before".equals(el.getStaticRowCells().getPosition())) {
            addStaticRows(table, el.getStaticRowCells(), colCount, cellFont);
        }

        // ---- 合计区（v1 保留） ----
        if (el.getSummary() != null) {
            for (EvaluatedElement.EvaluatedSummary s : el.getSummary()) {
                PdfPCell labelCell = new PdfPCell(new Phrase(s.getLabel() == null ? "" : s.getLabel(), boldFont));
                labelCell.setColspan(Math.max(1, colCount - 1));
                labelCell.setHorizontalAlignment(Element.ALIGN_RIGHT);
                labelCell.setPadding(3f);
                table.addCell(labelCell);
                PdfPCell valueCell = new PdfPCell(new Phrase(s.getValue() == null ? "" : s.getValue(), boldFont));
                valueCell.setHorizontalAlignment(toAlignment(s.getAlign() != null ? s.getAlign() : "right"));
                valueCell.setPadding(3f);
                table.addCell(valueCell);
            }
        }

        // ---- A5 跨页重复表头：表头网格整体作为表格 header rows ----
        if (Boolean.TRUE.equals(el.getRepeatHeaderOnPageBreak()) && headerRowCount > 0) {
            table.setHeaderRows(headerRowCount);
        }
        return table;
    }

    /** 明细行：逐列 addCell；subtable 容器列渲染嵌套子表（rowIndex 对齐求值层 rowSubtables） */
    private void addDetailRow(PdfPTable table, List<String> row, List<TableColumn> cols,
                              Font cellFont, EvaluatedElement el, int rowIndex) throws Exception {
        for (int i = 0; i < cols.size(); i++) {
            String cellValue = i < row.size() && row.get(i) != null ? row.get(i) : "";
            PdfPCell cell;
            EvaluatedElement.EvaluatedSubtable sub = findSubtable(el, i);
            if (sub != null) {
                cell = new PdfPCell(buildSubtable(sub, rowIndex));
            } else {
                cell = new PdfPCell(new Phrase(cellValue, cellFont));
                cell.setHorizontalAlignment(toAlignment(cols.get(i).getAlign()));
            }
            cell.setPadding(3f);
            table.addCell(cell);
        }
    }

    private EvaluatedElement.EvaluatedSubtable findSubtable(EvaluatedElement el, int colIdx) {
        if (el.getSubtables() == null) {
            return null;
        }
        for (EvaluatedElement.EvaluatedSubtable st : el.getSubtables()) {
            if (st.getColumnIndex() == colIdx) {
                return st;
            }
        }
        return null;
    }

    /** 子表渲染：嵌套 PdfPTable（子表头 + 子行集）；主行无子数据时渲染子表头空表 */
    private PdfPTable buildSubtable(EvaluatedElement.EvaluatedSubtable sub, int rowIndex) {
        List<TableColumn> subCols = sub.getColumns();
        int subColCount = Math.max(1, subCols.size());
        PdfPTable subTable = new PdfPTable(subColCount);
        subTable.setWidthPercentage(100);
        Font subHeaderFont = new Font(cjkBaseFont, DEFAULT_FONT_SIZE - 1, Font.BOLD);
        Font subCellFont = new Font(cjkBaseFont, DEFAULT_FONT_SIZE - 1, Font.NORMAL);
        if (sub.getHeaders() != null) {
            for (String h : sub.getHeaders()) {
                PdfPCell hc = new PdfPCell(new Phrase(h == null ? "" : h, subHeaderFont));
                hc.setBackgroundColor(new Color(0xF7, 0xF7, 0xF7));
                hc.setHorizontalAlignment(Element.ALIGN_CENTER);
                hc.setPadding(2f);
                subTable.addCell(hc);
            }
        }
        List<List<List<String>>> rowSubtables = sub.getRowSubtables();
        if (rowSubtables != null && rowIndex >= 0 && rowIndex < rowSubtables.size()) {
            for (List<String> subRow : rowSubtables.get(rowIndex)) {
                for (int i = 0; i < subColCount; i++) {
                    String v = i < subRow.size() && subRow.get(i) != null ? subRow.get(i) : "";
                    PdfPCell sc = new PdfPCell(new Phrase(v, subCellFont));
                    if (i < subCols.size()) {
                        sc.setHorizontalAlignment(toAlignment(subCols.get(i).getAlign()));
                    }
                    sc.setPadding(2f);
                    subTable.addCell(sc);
                }
            }
        }
        return subTable;
    }

    /** 静态行区渲染：colspan/rowspan 合并单元格 */
    private void addStaticRows(PdfPTable table, EvaluatedElement.EvaluatedStaticRows sr,
                               int colCount, Font cellFont) {
        if (sr.getRows() == null) {
            return;
        }
        for (List<EvaluatedElement.EvaluatedTableCell> row : sr.getRows()) {
            for (EvaluatedElement.EvaluatedTableCell cell : row) {
                PdfPCell pc = new PdfPCell(new Phrase(
                        cell.getValue() == null ? " " : cell.getValue(), cellFont));
                if (cell.getColspan() != null && cell.getColspan() > 1) {
                    pc.setColspan(Math.min(cell.getColspan(), colCount));
                }
                if (cell.getRowspan() != null && cell.getRowspan() > 1) {
                    pc.setRowspan(cell.getRowspan());
                }
                pc.setHorizontalAlignment(toAlignment(cell.getAlign()));
                pc.setPadding(3f);
                applyBoxStyle(pc, cell.getStyle());
                table.addCell(pc);
            }
        }
    }

    /**
     * 斜线表头单元格事件：按 diagonal 方向画对角线（ltr=左上→右下，rtl=左下→右上，both=十字），
     * diagonalLabels 按四角定位文字（tl/tr/bl/br，避开斜线几何位置）。
     */
    private class DiagonalHeaderEvent implements com.lowagie.text.pdf.PdfPCellEvent {
        private final EvaluatedElement.EvaluatedHeaderCell hc;

        DiagonalHeaderEvent(EvaluatedElement.EvaluatedHeaderCell hc) {
            this.hc = hc;
        }

        @Override
        public void cellLayout(PdfPCell cell, com.lowagie.text.Rectangle position,
                               com.lowagie.text.pdf.PdfContentByte[] canvases) {
            com.lowagie.text.pdf.PdfContentByte canvas = canvases[com.lowagie.text.pdf.PdfPTable.LINECANVAS];
            float llx = position.getLeft();
            float lly = position.getBottom();
            float urx = position.getRight();
            float ury = position.getTop();
            canvas.saveState();
            canvas.setLineWidth(0.6f);
            canvas.setColorStroke(Color.BLACK);
            String d = hc.getDiagonal();
            if ("ltr".equals(d) || "both".equals(d)) {
                canvas.moveTo(llx, lly);
                canvas.lineTo(urx, ury);
                canvas.stroke();
            }
            if ("rtl".equals(d) || "both".equals(d)) {
                canvas.moveTo(llx, ury);
                canvas.lineTo(urx, lly);
                canvas.stroke();
            }
            canvas.restoreState();
            // 四角标注文字（斜线两侧避让：沿边内缩 2pt）
            if (hc.getDiagonalLabels() != null) {
                com.lowagie.text.pdf.PdfContentByte textCanvas =
                        canvases[com.lowagie.text.pdf.PdfPTable.TEXTCANVAS];
                Font labelFont = new Font(cjkBaseFont, DEFAULT_FONT_SIZE - 2, Font.NORMAL);
                drawCornerLabel(textCanvas, hc.getDiagonalLabels().get("tl"), llx + 2, ury - 2,
                        labelFont, true);
                drawCornerLabel(textCanvas, hc.getDiagonalLabels().get("tr"), urx - 2, ury - 2,
                        labelFont, false);
                drawCornerLabel(textCanvas, hc.getDiagonalLabels().get("bl"), llx + 2, lly + 2,
                        labelFont, true);
                drawCornerLabel(textCanvas, hc.getDiagonalLabels().get("br"), urx - 2, lly + 2,
                        labelFont, false);
            }
        }

        private void drawCornerLabel(com.lowagie.text.pdf.PdfContentByte canvas, String text,
                                     float x, float y, Font font, boolean leftAlign) {
            if (text == null || text.isEmpty()) {
                return;
            }
            ColumnText.showTextAligned(canvas,
                    leftAlign ? Element.ALIGN_LEFT : Element.ALIGN_RIGHT,
                    new Phrase(text, font), x, y, 0);
        }
    }

    /** 列宽 → PdfPTable 相对宽度（百分比/mill 归一为相对值；全部未指定返回 null） */
    private float[] relativeWidths(List<TableColumn> cols) {
        float[] widths = new float[cols.size()];
        boolean any = false;
        for (int i = 0; i < cols.size(); i++) {
            String w = cols.get(i).getWidth();
            if (w != null && LengthUtil.isPercent(w)) {
                widths[i] = (float) Math.max(1, LengthUtil.parsePercent(w));
                any = true;
            } else if (w != null) {
                widths[i] = Math.max(1, LengthUtil.mmToPoints(w, 0));
                any = widths[i] > 0 || any;
            } else {
                widths[i] = -1;
            }
        }
        if (!any) {
            return null;
        }
        for (int i = 0; i < widths.length; i++) {
            if (widths[i] <= 0) {
                widths[i] = 10;
            }
        }
        return widths;
    }

    private PdfPTable buildKvTable(EvaluatedElement el) throws Exception {
        int pairs = el.getKvColumns() == null || el.getKvColumns() < 1 ? 1 : el.getKvColumns();
        PdfPTable table = new PdfPTable(pairs * 2);
        table.setWidthPercentage(100);
        Font keyFont = new Font(cjkBaseFont, DEFAULT_FONT_SIZE, Font.NORMAL, new Color(0x66, 0x66, 0x66));
        Font valueFont = new Font(cjkBaseFont, DEFAULT_FONT_SIZE, Font.NORMAL);
        if (el.getKvRows() != null) {
            for (List<String[]> row : el.getKvRows()) {
                for (int i = 0; i < pairs; i++) {
                    String[] pair = i < row.size() ? row.get(i) : null;
                    String k = pair != null && pair.length > 0 && pair[0] != null ? pair[0] : "";
                    String v = pair != null && pair.length > 1 && pair[1] != null ? pair[1] : "";
                    PdfPCell kc = new PdfPCell(new Phrase(k, keyFont));
                    kc.setPadding(3f);
                    table.addCell(kc);
                    PdfPCell vc = new PdfPCell(new Phrase(v, valueFont));
                    vc.setPadding(3f);
                    table.addCell(vc);
                }
            }
        }
        return table;
    }

    private Image buildCode(EvaluatedElement el) throws Exception {
        String content = el.getText() == null ? "" : el.getText();
        if (content.isEmpty()) {
            return null;
        }
        BufferedImage awt;
        float defaultHeight;
        if ("qrcode".equals(el.getType())) {
            int size = el.getSize() == null ? 6 : el.getSize();
            awt = barcodeRenderer.renderQrImage(content, Math.max(48, size * 8));
            defaultHeight = 25;
        } else {
            Symbology symbology = Symbology.of(el.getSymbology());
            awt = barcodeRenderer.render(content, symbology, 300, 60);
            defaultHeight = 12;
        }
        Image img = Image.getInstance(awt, null);
        float height = LengthUtil.mmToPoints(el.getHeight(), defaultHeight);
        float width = LengthUtil.mmToPoints(el.getWidth(),
                height * awt.getWidth() / (float) awt.getHeight());
        img.scaleToFit(width, height);
        img.setAlignment(toAlignment(el.getAlign() != null ? el.getAlign() : "center"));
        return img;
    }

    private void renderElements(Document doc, List<Element> elements) throws Exception {
        for (Element element : elements) {
            checkInterrupted();
            doc.add(element);
        }
    }

    /**
     * 元素级中断检查点。
     *
     * <p>口径：CPU 密集段无法硬杀（如 CJK 栅格化中途），元素边界已足够——
     * 超时后 Future.cancel(true) 中断渲染线程，线程在下一个元素边界发现中断
     * 立即抛 RENDER_TIMEOUT，尽快归还池线程。PDF 的 section 循环对应
     * buildElements（求值构造）与 renderElements（OpenPDF 排版）两道循环。
     */
    private static void checkInterrupted() {
        if (Thread.interrupted()) {
            throw PrintKernelException.builder()
                    .errorCode(PrintErrorCode.RENDER_TIMEOUT)
                    .message("渲染线程已中断（超时取消）")
                    .build();
        }
    }

    private Paragraph spacing(float height) {
        Paragraph p = new Paragraph();
        p.setSpacingAfter(height);
        p.add(new Phrase(" "));
        return p;
    }

    private float estimateHeight(List<Element> elements) {
        if (elements == null || elements.isEmpty()) {
            return 0;
        }
        float h = 0;
        for (Element element : elements) {
            if (element instanceof Paragraph) {
                h += ((Paragraph) element).getFont() != null
                        ? ((Paragraph) element).getFont().getSize() * 1.4f : DEFAULT_FONT_SIZE * 1.4f;
            } else if (element instanceof PdfPTable) {
                h += 20;
            } else {
                h += DEFAULT_FONT_SIZE * 1.4f;
            }
        }
        return h;
    }

    private Font toFont(dev.taprint.dsl.DslStyle style) {
        float size = DEFAULT_FONT_SIZE;
        int styleFlags = Font.NORMAL;
        Color color = Color.BLACK;
        if (style != null) {
            if (style.getFontSize() instanceof Number) {
                size = ((Number) style.getFontSize()).floatValue();
            } else if ("double".equals(String.valueOf(style.getFontSize()))) {
                size = DEFAULT_FONT_SIZE * 1.6f;
            }
            if (Boolean.TRUE.equals(style.getBold())) {
                styleFlags |= Font.BOLD;
            }
            if (Boolean.TRUE.equals(style.getItalic())) {
                styleFlags |= Font.ITALIC;
            }
            if (Boolean.TRUE.equals(style.getUnderline())) {
                styleFlags |= Font.UNDERLINE;
            }
            if (style.getColor() != null) {
                color = parseColor(style.getColor(), Color.BLACK);
            }
        }
        return new Font(cjkBaseFont, size, styleFlags, color);
    }

    static Color parseColor(String hex, Color fallback) {
        try {
            String s = hex.trim().replace("#", "");
            if (s.length() == 3) {
                StringBuilder sb = new StringBuilder();
                for (char c : s.toCharArray()) {
                    sb.append(c).append(c);
                }
                s = sb.toString();
            }
            return new Color(Integer.parseInt(s.substring(0, 2), 16),
                    Integer.parseInt(s.substring(2, 4), 16),
                    Integer.parseInt(s.substring(4, 6), 16));
        } catch (Exception e) {
            return fallback;
        }
    }

    static int toAlignment(String align) {
        if ("center".equalsIgnoreCase(align)) {
            return Element.ALIGN_CENTER;
        }
        if ("right".equalsIgnoreCase(align)) {
            return Element.ALIGN_RIGHT;
        }
        return Element.ALIGN_LEFT;
    }

    private Rectangle toRectangle(PageSpec page) {
        if (page == null) {
            return com.lowagie.text.PageSize.A4;
        }
        String size = page.getSize() == null ? "A4" : page.getSize().toUpperCase();
        Rectangle rect;
        switch (size) {
            case "A5":
                rect = com.lowagie.text.PageSize.A5;
                break;
            case "LETTER":
                rect = com.lowagie.text.PageSize.LETTER;
                break;
            case "CUSTOM":
                float w = LengthUtil.mmToPoints(page.getWidth(), 210);
                float h = LengthUtil.mmToPoints(page.getHeight(), 297);
                rect = new Rectangle(w, h);
                break;
            case "A4":
            default:
                rect = com.lowagie.text.PageSize.A4;
        }
        if ("landscape".equalsIgnoreCase(page.getOrientation())) {
            rect = rect.rotate();
        }
        return rect;
    }

    /** left/right/bottom/top（pt） */
    private float[] toMargins(PageSpec page) {
        float def = LengthUtil.mmToPoints("15mm", 15);
        float left = def, right = def, top = def, bottom = def;
        if (page != null && page.getMargin() != null) {
            left = LengthUtil.mmToPoints(page.getMargin().getLeft(), 15);
            right = LengthUtil.mmToPoints(page.getMargin().getRight(), 15);
            top = LengthUtil.mmToPoints(page.getMargin().getTop(), 15);
            bottom = LengthUtil.mmToPoints(page.getMargin().getBottom(), 15);
        }
        return new float[]{left, right, bottom, top};
    }

    /**
     * doc 页事件：水印（最底层，先绘）+ 页脚（底部边距区），每页 onEndPage 统一绘制。
     *
     * <p>水印：text 型按 style 字号绘制文字、image 型按 PrintImageLoader 加载；
     * opacity 经 PdfGState 透明度、angle 旋转；tile=true 平铺整页（网格步进 = 水印尺寸×2.5），
     * false 居中单枚（占页面短边 60%）。加载失败仅告警不阻断打印。
     */
    private class DocPageEvent extends PdfPageEventHelper {
        private final List<Element> footerElements;
        private final float footerHeight;
        private final dev.taprint.dsl.Watermark watermark;

        DocPageEvent(List<Element> footerElements, float footerHeight,
                     dev.taprint.dsl.Watermark watermark) {
            this.footerElements = footerElements;
            this.footerHeight = footerHeight;
            this.watermark = watermark;
        }

        @Override
        public void onEndPage(PdfWriter writer, Document document) {
            try {
                if (watermark != null) {
                    drawWatermark(writer, document);
                }
                if (footerElements != null && !footerElements.isEmpty()) {
                    ColumnText ct = new ColumnText(writer.getDirectContent());
                    float left = document.leftMargin();
                    float right = document.getPageSize().getWidth() - document.rightMargin();
                    float top = document.bottomMargin() - 2;
                    float bottom = Math.max(2, document.bottomMargin() - footerHeight - 4);
                    ct.setSimpleColumn(left, bottom, right, top);
                    for (Element element : footerElements) {
                        ct.addElement(element);
                    }
                    ct.go();
                }
            } catch (Exception e) {
                log.warn("页事件渲染失败（水印/页脚）: {}", e.getMessage());
            }
        }

        private void drawWatermark(PdfWriter writer, Document document) {
            // 此前损坏图片在 saveState 之后抛异常导致图形状态栈不平衡，
            // 后续页面/doc.close() 崩溃（Unbalanced save/restore state operators）
            com.lowagie.text.pdf.PdfContentByte canvas = writer.getDirectContentUnder();
            canvas.saveState();
            try {
                float pageW = document.getPageSize().getWidth();
                float pageH = document.getPageSize().getHeight();
                float opacity = watermark.getOpacity() == null ? 0.15f
                        : Math.max(0.01f, Math.min(1f, watermark.getOpacity().floatValue()));
                double angleDeg = watermark.getAngle() == null ? -30d
                        : Math.max(-90d, Math.min(90d, watermark.getAngle()));
                boolean tile = Boolean.TRUE.equals(watermark.getTile());

                com.lowagie.text.pdf.PdfGState gs = new com.lowagie.text.pdf.PdfGState();
                gs.setFillOpacity(opacity);
                gs.setStrokeOpacity(opacity);
                canvas.setGState(gs);

                if ("image".equals(watermark.getType())) {
                    byte[] bytes = imageLoader.load(watermark.getSrc());
                    if (bytes == null) {
                        return;
                    }
                    Image img = Image.getInstance(bytes);
                    float w;
                    float h;
                    if (tile) {
                        w = pageW / 4;
                        h = w * img.getHeight() / img.getWidth();
                    } else {
                        w = Math.min(pageW, pageH) * 0.6f;
                        h = w * img.getHeight() / img.getWidth();
                    }
                    img.scaleAbsolute(w, h);
                    if (tile) {
                        float stepX = w * 2.5f;
                        float stepY = h * 2.5f;
                        for (float y = 0; y < pageH + stepY; y += stepY) {
                            for (float x = -stepX; x < pageW + stepX; x += stepX) {
                                Image placed = Image.getInstance(img);
                                placed.setRotationDegrees((float) angleDeg);
                                placed.setAbsolutePosition(x, y);
                                canvas.addImage(placed);
                            }
                        }
                    } else {
                        img.setRotationDegrees((float) angleDeg);
                        img.setAbsolutePosition((pageW - w) / 2, (pageH - h) / 2);
                        canvas.addImage(img);
                    }
                } else {
                    // text 型
                    String text = watermark.getText() == null ? "" : watermark.getText();
                    if (text.isEmpty()) {
                        return;
                    }
                    dev.taprint.dsl.DslStyle wmStyle = watermark.getStyle();
                    float fontSize = DEFAULT_FONT_SIZE * 3;
                    Color color = new Color(0x99, 0x99, 0x99);
                    if (wmStyle != null) {
                        if (wmStyle.getFontSize() instanceof Number) {
                            fontSize = ((Number) wmStyle.getFontSize()).floatValue();
                        }
                        if (wmStyle.getColor() != null) {
                            color = parseColor(wmStyle.getColor(), color);
                        }
                    }
                    Font font = new Font(cjkBaseFont, fontSize, Font.NORMAL, color);
                    if (tile) {
                        float textW = fontSize * text.length() * 0.6f;
                        float textH = fontSize * 1.4f;
                        float stepX = Math.max(textW * 1.5f, 100);
                        float stepY = Math.max(textH * 4f, 100);
                        for (float y = stepY / 4; y < pageH + stepY; y += stepY) {
                            for (float x = -stepX / 2; x < pageW + stepX; x += stepX) {
                                ColumnText.showTextAligned(canvas, Element.ALIGN_CENTER,
                                        new Phrase(text, font), x, y, (float) angleDeg);
                            }
                        }
                    } else {
                        ColumnText.showTextAligned(canvas, Element.ALIGN_CENTER,
                                new Phrase(text, font), pageW / 2, pageH / 2, (float) angleDeg);
                    }
                }
            } catch (Exception e) {
                log.warn("水印渲染失败，跳过: {}", e.getMessage());
            } finally {
                canvas.restoreState();
            }
        }
    }
}
