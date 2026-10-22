/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.renderer;

import dev.taprint.barcode.BarcodeRenderer;
import dev.taprint.barcode.Symbology;
import dev.taprint.core.PrintErrorCode;
import dev.taprint.core.PrintKernelException;

import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import javax.imageio.ImageIO;

/**
 * ZPL 本地预览器：ZPL → PNG 纯 Java 光栅，不调任何外部服务。
 *
 * <p>前身 = 提取源工程的 {@code modules/print/renderer/LabelaryClient.java}
 * （Labelary HTTP 渲染服务客户端，POST {url}/printers/{dpmm}/labels/{w}/{h}/{fmt}，
 * 10s 超时、x-api-key 头、免费档服务器 60 天留存 ⇒ PII 白名单红线）。
 * v0.2 收编进内核时按零外呼纪律改造为本地光栅：AWT 文本光栅（与内核
 * CjkRasterizer 同 FontProvider 源）+ ZXing 码图 + JDK ImageIO PNG 编码，
 * 零新增依赖、零网络外呼——数据不出本机，原 PII 白名单红线随之消解。
 *
 * <p>覆盖面 = {@link ZplRenderer} v0.2 出面子集 + ^GFA 位图（^XA/^LH/^PQ/^FS/^XZ
 * 等结构指令仅推进解析状态机）；像素级为预览近似：一维码宽度按内容估算、
 * 文本光栅与打印机内置字库不同源——预览产物不入 golden 断言面，
 * 登记 docs/conformance.md。
 */
public class ZplPreviewer {

    /** 缺省画布（dot）——^PW/^LL 缺省时的 60×40mm@8dot/mm 画幅。 */
    private static final int DEFAULT_WIDTH = 480;
    private static final int DEFAULT_HEIGHT = 320;

    /** 一维码位图宽度估算系数（每字符 ≈ 11 模块 × 窄条 2 dot，预览近似）。 */
    private static final int BARCODE_WIDTH_PER_CHAR = 22;

    private final CjkRasterizer rasterizer;
    private final BarcodeRenderer barcodeRenderer;

    public ZplPreviewer() {
        this(new CjkRasterizer(), new BarcodeRenderer());
    }

    public ZplPreviewer(CjkRasterizer rasterizer, BarcodeRenderer barcodeRenderer) {
        this.rasterizer = rasterizer;
        this.barcodeRenderer = barcodeRenderer;
    }

    /**
     * 渲染 ZPL 为 PNG 字节（黑白语义、8bit 灰度画布）。
     *
     * @param zpl ZPL 指令流（{@link ZplRenderer} 产物或兼容子集）
     * @return PNG 字节；入参缺 ^XA 帧时抛 RENDER_FAILED
     */
    public byte[] renderToPng(String zpl) {
        if (zpl == null || !zpl.contains("^XA")) {
            throw PrintKernelException.of(PrintErrorCode.RENDER_FAILED, "ZPL 预览入参缺 ^XA 帧");
        }
        int width = intValue(commandParams(zpl, "PW"), DEFAULT_WIDTH);
        int height = intValue(commandParams(zpl, "LL"), DEFAULT_HEIGHT);
        BufferedImage canvas = new BufferedImage(Math.max(1, width), Math.max(1, height),
                BufferedImage.TYPE_BYTE_GRAY);
        draw(zpl, canvas);
        return encodePng(canvas);
    }

    // ------------------------------------------------------------------
    // 指令流解析（^ + 两字母指令码 + 参数段，参数段止于下一个 ^）
    // ------------------------------------------------------------------

    /** 首个指令码为 {@code code} 的参数段（找不到返回 null）。 */
    private static String commandParams(String zpl, String code) {
        int from = 0;
        while (true) {
            int at = zpl.indexOf('^' + code, from);
            if (at < 0 || at + 3 > zpl.length()) {
                return null;
            }
            // ^P 不会误命中 ^PW 之外的指令（两字母码全等匹配后取参数段）
            int end = zpl.indexOf('^', at + 3);
            if (end < 0) {
                end = zpl.length();
            }
            return zpl.substring(at + 3, end);
        }
    }

    private static int intValue(String params, int fallback) {
        if (params == null || params.isEmpty()) {
            return fallback;
        }
        try {
            return Integer.parseInt(params.trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private void draw(String zpl, BufferedImage canvas) {
        Graphics2D g = canvas.createGraphics();
        g.setColor(Color.WHITE);
        g.fillRect(0, 0, canvas.getWidth(), canvas.getHeight());
        try {
            int x = 0;
            int y = 0;
            int fontHeight = 28;
            int barcodeHeight = 80;
            int qrModule = 6;
            String symbologyCode = null;
            String fieldData = null;
            int i = 0;
            int length = zpl.length();
            while (i < length) {
                if (zpl.charAt(i) != '^' || i + 3 > length
                        || !Character.isUpperCase(zpl.charAt(i + 1))
                        || !Character.isLetterOrDigit(zpl.charAt(i + 2))) {
                    i++;
                    continue;
                }
                String code = zpl.substring(i + 1, i + 3);
                int end = zpl.indexOf('^', i + 3);
                if (end < 0) {
                    end = length;
                }
                String params = zpl.substring(i + 3, end);
                i = end;
                switch (code) {
                    case "FO": {
                        String[] xy = splitArgs(params);
                        x = intAt(xy, 0, 0);
                        y = intAt(xy, 1, 0);
                        break;
                    }
                    case "A0": {
                        String[] args = splitArgs(params);
                        fontHeight = Math.max(8, intAt(args, 1, 28));
                        break;
                    }
                    case "BY": {
                        barcodeHeight = Math.max(8, intAt(splitArgs(params), 2, 80));
                        break;
                    }
                    case "BC":
                    case "BE":
                    case "B3":
                    case "B2":
                    case "BU":
                        symbologyCode = code;
                        break;
                    case "BQ": {
                        qrModule = Math.max(1, Math.min(10, intAt(splitArgs(params), 2, 6)));
                        break;
                    }
                    case "FD":
                        fieldData = params;
                        break;
                    case "FS":
                        commitField(g, symbologyCode, fontHeight, barcodeHeight, qrModule,
                                fieldData, x, y, canvas);
                        fieldData = null;
                        symbologyCode = null;
                        break;
                    case "GB": {
                        String[] wht = splitArgs(params);
                        drawBox(g, x, y, intAt(wht, 0, 0), intAt(wht, 1, 0), intAt(wht, 2, 1));
                        break;
                    }
                    case "GF": {
                        drawGfa(g, params, x, y);
                        break;
                    }
                    default:
                        break;
                }
            }
        } finally {
            g.dispose();
        }
    }

    /** ^FS 收口：按前置指令分派文本/一维码/QR（无前置指令 = 空域，忽略）。 */
    private void commitField(Graphics2D g, String symbologyCode, int fontHeight,
            int barcodeHeight, int qrModule, String data, int x, int y, BufferedImage canvas) {
        if (data == null) {
            return;
        }
        String content = unescape(data);
        if (content.isEmpty()) {
            return;
        }
        if (symbologyCode == null) {
            BufferedImage text = rasterizer.rasterize(content, fontHeight);
            g.drawImage(text, x, y, null);
            return;
        }
        if ("BQ".equals(symbologyCode)) {
            try {
                var matrix = barcodeRenderer.renderQrMatrix(content, qrModule);
                g.setColor(Color.BLACK);
                for (int row = 0; row < matrix.getHeight(); row++) {
                    for (int col = 0; col < matrix.getWidth(); col++) {
                        if (matrix.get(col, row)) {
                            g.fillRect(x + col * qrModule, y + row * qrModule, qrModule, qrModule);
                        }
                    }
                }
            } catch (RuntimeException e) {
                // 预览级容错：二维码内容问题不炸预览
            }
            return;
        }
        drawBarcode(g, symbologyCode, content, barcodeHeight, x, y, canvas);
    }

    /** 一维码：ZXing 码图（宽度按内容估算；内容非法等预览级失败静默跳过）。 */
    private void drawBarcode(Graphics2D g, String code, String content,
            int height, int x, int y, BufferedImage canvas) {
        Symbology symbology;
        switch (code) {
            case "BE":
                symbology = content.length() == 8 ? Symbology.EAN8 : Symbology.EAN13;
                break;
            case "B3":
                symbology = Symbology.CODE39;
                break;
            case "B2":
                symbology = Symbology.ITF;
                break;
            case "BU":
                symbology = Symbology.UPC;
                break;
            default:
                symbology = Symbology.CODE128;
                break;
        }
        int width = Math.min(canvas.getWidth() - x,
                Math.max(32, content.length() * BARCODE_WIDTH_PER_CHAR));
        try {
            BufferedImage barcode = barcodeRenderer.render(content, symbology, Math.max(16, width), height);
            g.drawImage(barcode, x, y, null);
        } catch (RuntimeException e) {
            // 预览级容错：校验位不符等内容问题不炸预览（产出差异登记 conformance.md）
        }
    }

    private static void drawBox(Graphics2D g, int x, int y, int w, int h, int t) {
        int thickness = Math.max(1, t);
        g.setColor(Color.BLACK);
        g.setStroke(new BasicStroke(thickness));
        // ^GB w,h 为框全尺寸；内缩描边近似打印机内侧描边口径
        g.drawRect(x + thickness / 2, y + thickness / 2,
                Math.max(1, w - thickness), Math.max(1, h - thickness));
    }

    /** ^GFA,total,total,perRow,<hex> → 位图（MSB 在左，1=暗，与编码器同口径）。 */
    private static void drawGfa(Graphics2D g, String params, int x, int y) {
        String[] args = params.split(",", 5);
        if (args.length < 5) {
            return;
        }
        int perRow;
        try {
            perRow = Integer.parseInt(args[3].trim());
        } catch (NumberFormatException e) {
            return;
        }
        String hex = args[4].trim();
        if (perRow <= 0 || hex.isEmpty()) {
            return;
        }
        int rows = hex.length() / (perRow * 2);
        g.setColor(Color.BLACK);
        for (int row = 0; row < rows; row++) {
            for (int byteIdx = 0; byteIdx < perRow; byteIdx++) {
                int hi = Character.digit(hex.charAt((row * perRow + byteIdx) * 2), 16);
                int lo = Character.digit(hex.charAt((row * perRow + byteIdx) * 2 + 1), 16);
                if (hi < 0 || lo < 0) {
                    continue;
                }
                int bits = (hi << 4) | lo;
                for (int bit = 0; bit < 8; bit++) {
                    if ((bits & (0x80 >> bit)) != 0) {
                        g.fillRect(x + byteIdx * 8 + bit, y + row, 1, 1);
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // 工具
    // ------------------------------------------------------------------

    private static String[] splitArgs(String params) {
        return params == null || params.isEmpty() ? new String[0] : params.split(",");
    }

    private static int intAt(String[] args, int index, int fallback) {
        if (index >= args.length) {
            return fallback;
        }
        try {
            return Integer.parseInt(args[index].trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    /** ^FD 域反转义：\X → X（\\ \^ \~ 单遍处理）。 */
    static String unescape(String data) {
        StringBuilder sb = new StringBuilder(data.length());
        for (int i = 0; i < data.length(); i++) {
            char c = data.charAt(i);
            if (c == '\\' && i + 1 < data.length()) {
                i++;
                sb.append(data.charAt(i));
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    private byte[] encodePng(BufferedImage image) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(1 << 16);
        try {
            if (!ImageIO.write(image, "png", out)) {
                throw PrintKernelException.of(PrintErrorCode.RENDER_FAILED, "无可用 PNG 编码器");
            }
        } catch (IOException e) {
            throw PrintKernelException.of(PrintErrorCode.RENDER_FAILED, "PNG 编码失败: " + e.getMessage());
        }
        return out.toByteArray();
    }
}
