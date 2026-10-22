/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.golden;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Golden L1 帧提取与规范化（ADR-0010）。
 *
 * <p>从三协议字节流提取「序号|协议助记|参数键=值」帧序列，规则：
 * <ul>
 *   <li>TSPL/CPCL：按行切帧（CRLF/LF 均可），行首词为助记，参数逐命令定序；</li>
 *   <li>ESC/POS：按控制字节逐命令切帧，正文段聚合为 TEXT 帧；</li>
 *   <li>内容参数一律按原始字节序列化：可见 ASCII 原样，其余每字节 {@code \xXX}，
 *       引号/反斜杠/CR/LF 转义——不做 GBK 解码，跨语言逐字节可复现。</li>
 * </ul>
 */
public final class GoldenFrames {

    private GoldenFrames() {
    }

    /** 单帧：助记 + 有序参数（k=v 串）。 */
    public static final class Frame {
        public final String mnemonic;
        public final List<String> params = new ArrayList<>();

        public Frame(String mnemonic) {
            this.mnemonic = mnemonic;
        }

        public Frame p(String key, String value) {
            params.add(key + "=" + value);
            return this;
        }

        public String paramLine() {
            return params.isEmpty() ? "-" : String.join(";", params);
        }
    }

    /** 序列化整帧列表为 frames.txt 文本（行序即帧序，末行带换行）。 */
    public static String render(List<Frame> frames) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < frames.size(); i++) {
            Frame f = frames.get(i);
            sb.append(String.format("%03d", i + 1)).append('|').append(f.mnemonic)
                    .append('|').append(f.paramLine()).append('\n');
        }
        return sb.toString();
    }

    // ------------------------------------------------------------------
    // 内容参数序列化（原始字节形态，跨语言唯一真值）
    // ------------------------------------------------------------------

    static String escapeContent(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) {
            int v = b & 0xFF;
            if (v == '\\') {
                sb.append("\\\\");
            } else if (v == '"') {
                sb.append("\\\"");
            } else if (v == '\r') {
                sb.append("\\r");
            } else if (v == '\n') {
                sb.append("\\n");
            } else if (v == '\t') {
                sb.append("\\t");
            } else if (v >= 0x20 && v <= 0x7E) {
                sb.append((char) v);
            } else {
                sb.append(String.format("\\x%02X", v));
            }
        }
        return sb.toString();
    }

    // ------------------------------------------------------------------
    // TSPL
    // ------------------------------------------------------------------

    /** TSPL 帧提取：逐行（GBK 通道内容按原始字节参与切分，引号内逗号不切）。 */
    public static List<Frame> tspl(byte[] payload) {
        List<Frame> frames = new ArrayList<>();
        for (byte[] line : splitLines(payload)) {
            if (line.length == 0) {
                continue;
            }
            parseTsplLine(line, frames);
        }
        return frames;
    }

    private static void parseTsplLine(byte[] line, List<Frame> frames) {
        String text = new String(line, StandardCharsets.ISO_8859_1);
        String trimmed = text.trim();
        if (trimmed.startsWith("SIZE ")) {
            List<String> args = csv(text.substring(5));
            frames.add(new Frame("SIZE").p("w_mm", stripMm(args.get(0))).p("h_mm", stripMm(args.get(1))));
        } else if (trimmed.startsWith("GAP ")) {
            List<String> args = csv(text.substring(4));
            frames.add(new Frame("GAP").p("gap_mm", stripMm(args.get(0))).p("blackout_mm", stripMm(args.get(1))));
        } else if (trimmed.startsWith("BLINE ")) {
            List<String> args = csv(text.substring(6));
            frames.add(new Frame("BLINE").p("bline_mm", stripMm(args.get(0))).p("blackout_mm", stripMm(args.get(1))));
        } else if (trimmed.startsWith("DENSITY ")) {
            frames.add(new Frame("DENSITY").p("n", trimmed.substring(8)));
        } else if (trimmed.startsWith("SPEED ")) {
            frames.add(new Frame("SPEED").p("n", trimmed.substring(6)));
        } else if (trimmed.startsWith("DIRECTION ")) {
            frames.add(new Frame("DIRECTION").p("n", trimmed.substring(10)));
        } else if (trimmed.startsWith("SET TEAR ")) {
            frames.add(new Frame("SET_TEAR").p("state", trimmed.substring(9)));
        } else if (trimmed.equals("CLS")) {
            frames.add(new Frame("CLS"));
        } else if (trimmed.equals("FORMFEED")) {
            frames.add(new Frame("FORMFEED"));
        } else if (trimmed.startsWith("TEXT ")) {
            List<byte[]> args = csvBytes(line, 5);
            frames.add(new Frame("TEXT")
                    .p("x", s(args.get(0))).p("y", s(args.get(1)))
                    .p("font", unquote(args.get(2))).p("rotation", s(args.get(3)))
                    .p("x_mul", s(args.get(4))).p("y_mul", s(args.get(5)))
                    .p("content", escapeContent(unquoteBytes(args.get(6)))));
        } else if (trimmed.startsWith("BARCODE ")) {
            List<byte[]> args = csvBytes(line, 8);
            frames.add(new Frame("BARCODE")
                    .p("x", s(args.get(0))).p("y", s(args.get(1)))
                    .p("type", unquote(args.get(2))).p("height", s(args.get(3)))
                    .p("human", s(args.get(4))).p("rotation", s(args.get(5)))
                    .p("narrow", s(args.get(6))).p("wide", s(args.get(7)))
                    .p("content", escapeContent(unquoteBytes(args.get(8)))));
        } else if (trimmed.startsWith("QRCODE ")) {
            // 两种合法形态：8 段（model 复合 "M2"、无 mask——Java 参照渲染器）/
            // 9 段（model+mask 分立——TS 构造器）；mask/content 按段数分派
            List<byte[]> args = csvBytes(line, 7);
            boolean hasMask = args.size() > 8;
            frames.add(new Frame("QRCODE")
                    .p("x", s(args.get(0))).p("y", s(args.get(1)))
                    .p("ecc", s(args.get(2))).p("cell", s(args.get(3)))
                    .p("mode", s(args.get(4))).p("rotation", s(args.get(5)))
                    .p("model", s(args.get(6)))
                    .p("mask", hasMask ? s(args.get(7)) : "-")
                    .p("content", hasMask
                            ? escapeContent(unquoteBytes(args.get(8)))
                            : escapeContent(unquoteBytes(args.get(7)))));
        } else if (trimmed.startsWith("LINE ")) {
            List<String> args = csv(text.substring(5));
            frames.add(new Frame("LINE").p("x1", args.get(0)).p("y1", args.get(1))
                    .p("x2", args.get(2)).p("y2", args.get(3)).p("thickness", args.get(4)));
        } else if (trimmed.startsWith("BOX ")) {
            List<String> args = csv(text.substring(4));
            frames.add(boxLike("BOX", args));
        } else if (trimmed.startsWith("BAR ")) {
            List<String> args = csv(text.substring(4));
            frames.add(new Frame("BAR").p("x", args.get(0)).p("y", args.get(1))
                    .p("width", args.get(2)).p("height", args.get(3)));
        } else if (trimmed.startsWith("PRINT ")) {
            frames.add(new Frame("PRINT").p("copies", trimmed.substring(6)));
        } else if (trimmed.startsWith("BITMAP ")) {
            frames.add(new Frame("BITMAP").p("raw", escapeContent(line)));
        } else {
            frames.add(new Frame("UNKNOWN").p("raw", escapeContent(line)));
        }
    }

    private static Frame boxLike(String mnemonic, List<String> args) {
        return new Frame(mnemonic).p("x1", args.get(0)).p("y1", args.get(1))
                .p("x2", args.get(2)).p("y2", args.get(3))
                .p("thickness", args.size() > 4 ? args.get(4) : "-");
    }

    // ------------------------------------------------------------------
    // CPCL
    // ------------------------------------------------------------------

    /** CPCL 帧提取：格式头/TEXT/BARCODE/QR 三段式/LINE/BOX/FORM/PRINT。 */
    public static List<Frame> cpcl(byte[] payload) {
        List<Frame> frames = new ArrayList<>();
        for (byte[] line : splitLines(payload)) {
            if (line.length == 0) {
                continue;
            }
            parseCpclLine(line, frames);
        }
        return frames;
    }

    private static void parseCpclLine(byte[] line, List<Frame> frames) {
        String text = new String(line, StandardCharsets.ISO_8859_1).trim();
        if (text.startsWith("!")) {
            String[] tok = text.split(" +");
            // ! offset horz vert height qty
            frames.add(new Frame("HEADER")
                    .p("offset", tok[1]).p("horz", tok[2]).p("vert", tok[3])
                    .p("height", tok[4]).p("qty", tok[5]));
        } else if (text.startsWith("BARCODE QR ")) {
            // BARCODE QR x y M 2 U n
            String[] tok = text.split(" +");
            frames.add(new Frame("QR_BEGIN")
                    .p("x", tok[2]).p("y", tok[3]).p("sel", tok[4])
                    .p("model", tok[5]).p("unit", tok[7]));
        } else if (text.startsWith("M0A,")) {
            frames.add(new Frame("QR_DATA")
                    .p("prefix", "M0A")
                    .p("content", escapeContent(tailBytes(line, 4))));
        } else if (text.equals("ENDQR")) {
            frames.add(new Frame("QR_END"));
        } else if (text.startsWith("TEXT ")) {
            String[] head = text.split(" +", 6);
            frames.add(new Frame("TEXT")
                    .p("font", head[1]).p("size", head[2]).p("x", head[3]).p("y", head[4])
                    .p("content", escapeContent(tailBytes(line, head[0].length() + head[1].length()
                            + head[2].length() + head[3].length() + head[4].length() + 5))));
        } else if (text.startsWith("BARCODE-TEXT ")) {
            String[] head = text.split(" +", 6);
            frames.add(new Frame("BARCODE_TEXT")
                    .p("font", head[1]).p("size", head[2]).p("x", head[3]).p("y", head[4])
                    .p("content", escapeContent(tailBytes(line, head[0].length() + head[1].length()
                            + head[2].length() + head[3].length() + head[4].length() + 5))));
        } else if (text.startsWith("BARCODE ")) {
            // BARCODE type width ratio height x y content
            String[] tok = text.split(" +", 8);
            frames.add(new Frame("BARCODE")
                    .p("type", tok[1]).p("width", tok[2]).p("ratio", tok[3])
                    .p("height", tok[4]).p("x", tok[5]).p("y", tok[6])
                    .p("content", escapeContent(tailBytes(line, prefixLen(tok, 7)))));
        } else if (text.startsWith("LINE ")) {
            String[] tok = text.split(" +");
            frames.add(new Frame("LINE").p("x1", tok[1]).p("y1", tok[2])
                    .p("x2", tok[3]).p("y2", tok[4]).p("thickness", tok[5]));
        } else if (text.startsWith("BOX ")) {
            String[] tok = text.split(" +");
            frames.add(new Frame("BOX").p("x1", tok[1]).p("y1", tok[2])
                    .p("x2", tok[3]).p("y2", tok[4]).p("thickness", tok[5]));
        } else if (text.startsWith("EG ")) {
            frames.add(new Frame("EG").p("raw_len", String.valueOf(line.length)));
        } else if (text.equals("FORM")) {
            frames.add(new Frame("FORM"));
        } else if (text.equals("PRINT")) {
            frames.add(new Frame("PRINT"));
        } else {
            frames.add(new Frame("UNKNOWN").p("raw", escapeContent(line)));
        }
    }

    private static int prefixLen(String[] tok, int count) {
        // 内容前缀长度：各结构词 + 其后分隔空格（内容紧随最后一个空格之后）
        int len = 0;
        for (int i = 0; i < count; i++) {
            len += tok[i].length() + 1;
        }
        return len;
    }

    // ------------------------------------------------------------------
    // ESC/POS
    // ------------------------------------------------------------------

    /** ESC/POS 帧提取：按控制字节逐命令切帧；正文段聚合 TEXT 帧。 */
    public static List<Frame> escpos(byte[] payload) {
        List<Frame> frames = new ArrayList<>();
        ByteArrayOutputStream text = new ByteArrayOutputStream();
        int i = 0;
        while (i < payload.length) {
            int b = payload[i] & 0xFF;
            if (b == 0x0A) {
                flushText(frames, text);
                frames.add(new Frame("LF"));
                i += 1;
            } else if (b == 0x1B) {
                i = escCommand(payload, i, frames, text);
            } else if (b == 0x1C || b == 0x1D) {
                i = gsCommand(payload, i, frames, text);
            } else {
                text.write(payload[i]);
                i += 1;
            }
        }
        flushText(frames, text);
        return frames;
    }

    private static void flushText(List<Frame> frames, ByteArrayOutputStream text) {
        if (text.size() > 0) {
            byte[] bytes = text.toByteArray();
            text.reset();
            frames.add(new Frame("TEXT").p("content", escapeContent(bytes)));
        }
    }

    private static int escCommand(byte[] p, int i, List<Frame> frames, ByteArrayOutputStream text) {
        int cmd = p.length > i + 1 ? p[i + 1] & 0xFF : -1;
        switch (cmd) {
            case 0x40:
                flushText(frames, text);
                frames.add(new Frame("INIT"));
                return i + 2;
            case 0x61:
                flushText(frames, text);
                frames.add(new Frame("ALIGN").p("n", String.valueOf(p[i + 2] & 0xFF)));
                return i + 3;
            case 0x45:
                flushText(frames, text);
                frames.add(new Frame("BOLD").p("on", String.valueOf(p[i + 2] & 0xFF)));
                return i + 3;
            case 0x64:
                flushText(frames, text);
                frames.add(new Frame("FEED").p("lines", String.valueOf(p[i + 2] & 0xFF)));
                return i + 3;
            case 0x70:
                flushText(frames, text);
                frames.add(new Frame("DRAWER").p("m", String.valueOf(p[i + 2] & 0xFF))
                        .p("t1", String.valueOf(p[i + 3] & 0xFF))
                        .p("t2", String.valueOf(p[i + 4] & 0xFF)));
                return i + 5;
            default:
                flushText(frames, text);
                frames.add(new Frame("ESC_OTHER")
                        .p("raw", escapeContent(slice(p, i, Math.min(i + 4, p.length)))));
                return i + 2;
        }
    }

    private static int gsCommand(byte[] p, int i, List<Frame> frames, ByteArrayOutputStream text) {
        int lead = p[i] & 0xFF;
        int cmd = p.length > i + 1 ? p[i + 1] & 0xFF : -1;
        if (lead == 0x1C && cmd == 0x26) {
            flushText(frames, text);
            frames.add(new Frame("CN_ON"));
            return i + 2;
        }
        if (lead != 0x1D) {
            flushText(frames, text);
            frames.add(new Frame("ESC_OTHER")
                    .p("raw", escapeContent(slice(p, i, Math.min(i + 4, p.length)))));
            return i + 2;
        }
        switch (cmd) {
            case 0x21:
                flushText(frames, text);
                frames.add(new Frame("FONT_SIZE").p("n", String.valueOf(p[i + 2] & 0xFF)));
                return i + 3;
            case 0x48:
                flushText(frames, text);
                frames.add(new Frame("BAR_HRI").p("pos", String.valueOf(p[i + 2] & 0xFF)));
                return i + 3;
            case 0x68:
                flushText(frames, text);
                frames.add(new Frame("BAR_HEIGHT").p("dots", String.valueOf(p[i + 2] & 0xFF)));
                return i + 3;
            case 0x77:
                flushText(frames, text);
                frames.add(new Frame("BAR_WIDTH").p("dots", String.valueOf(p[i + 2] & 0xFF)));
                return i + 3;
            case 0x56:
                flushText(frames, text);
                frames.add(new Frame("CUT").p("mode", String.valueOf(p[i + 2] & 0xFF)));
                return i + 3;
            case 0x6B: {
                // GS k m n data（Function B 形态）
                flushText(frames, text);
                int m = p[i + 2] & 0xFF;
                int n = p[i + 3] & 0xFF;
                frames.add(new Frame("BAR_PRINT").p("m", String.valueOf(m))
                        .p("len", String.valueOf(n))
                        .p("content", escapeContent(slice(p, i + 4, i + 4 + n))));
                return i + 4 + n;
            }
            case 0x28: {
                // GS ( k …（QR 原生五步）
                if (p.length > i + 2 && (p[i + 2] & 0xFF) == 0x6B) {
                    return gsParenK(p, i, frames, text);
                }
                flushText(frames, text);
                frames.add(new Frame("GS_OTHER")
                        .p("raw", escapeContent(slice(p, i, Math.min(i + 8, p.length)))));
                return i + 4;
            }
            default:
                flushText(frames, text);
                frames.add(new Frame("GS_OTHER")
                        .p("raw", escapeContent(slice(p, i, Math.min(i + 4, p.length)))));
                return i + 3;
        }
    }

    private static int gsParenK(byte[] p, int i, List<Frame> frames, ByteArrayOutputStream text) {
        // GS ( k pL pH cn fn …：cn=0x31（QR），fn=0x41-0x51（A-Q）
        int pl = p[i + 3] & 0xFF;
        int ph = p[i + 4] & 0xFF;
        int len = (ph << 8) | pl;
        int fn = p[i + 6] & 0xFF;
        flushText(frames, text);
        switch (fn) {
            case 0x41:
                frames.add(new Frame("QR_MODEL").p("n", String.valueOf(p[i + 7] & 0xFF)));
                break;
            case 0x43:
                frames.add(new Frame("QR_SIZE").p("n", String.valueOf(p[i + 7] & 0xFF)));
                break;
            case 0x45:
                frames.add(new Frame("QR_ECC").p("n", String.valueOf(p[i + 7] & 0xFF)));
                break;
            case 0x50:
                frames.add(new Frame("QR_DATA").p("len", String.valueOf(len - 3))
                        .p("content", escapeContent(slice(p, i + 8, i + 5 + len))));
                break;
            case 0x51:
                frames.add(new Frame("QR_PRINT"));
                break;
            default:
                frames.add(new Frame("GS_OTHER").p("fn", String.valueOf(fn)));
                break;
        }
        return i + 5 + len;
    }

    // ------------------------------------------------------------------
    // 字节工具
    // ------------------------------------------------------------------

    static List<byte[]> splitLines(byte[] payload) {
        List<byte[]> lines = new ArrayList<>();
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int i = 0;
        while (i < payload.length) {
            int b = payload[i] & 0xFF;
            if (b == '\r') {
                lines.add(buf.toByteArray());
                buf.reset();
                i += 1;
                if (i < payload.length && (payload[i] & 0xFF) == '\n') {
                    i += 1;
                }
            } else if (b == '\n') {
                lines.add(buf.toByteArray());
                buf.reset();
                i += 1;
            } else {
                buf.write(payload[i]);
                i += 1;
            }
        }
        if (buf.size() > 0) {
            lines.add(buf.toByteArray());
        }
        return lines;
    }

    /** CSV 切分（引号感知；返回段含引号原文）。 */
    static List<byte[]> csvBytes(byte[] line, int from) {
        List<byte[]> parts = new ArrayList<>();
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        boolean inQuote = false;
        for (int i = from; i < line.length; i++) {
            byte b = line[i];
            if (b == '"' && (i == from || line[i - 1] != '\\')) {
                inQuote = !inQuote;
                buf.write(b);
            } else if (b == ',' && !inQuote) {
                parts.add(buf.toByteArray());
                buf.reset();
            } else {
                buf.write(b);
            }
        }
        parts.add(buf.toByteArray());
        return parts;
    }

    static List<String> csv(String text) {
        List<String> parts = new ArrayList<>();
        for (byte[] part : csvBytes(text.getBytes(StandardCharsets.ISO_8859_1), 0)) {
            parts.add(new String(part, StandardCharsets.ISO_8859_1).trim());
        }
        return parts;
    }

    static String s(byte[] bytes) {
        return new String(bytes, StandardCharsets.ISO_8859_1).trim();
    }

    static String unquote(byte[] bytes) {
        String v = s(bytes);
        if (v.length() >= 2 && v.startsWith("\"") && v.endsWith("\"")) {
            v = v.substring(1, v.length() - 1);
        }
        return v;
    }

    static byte[] unquoteBytes(byte[] bytes) {
        String v = s(bytes);
        if (v.length() >= 2 && v.startsWith("\"") && v.endsWith("\"")) {
            return slice(bytes, 1, bytes.length - 1);
        }
        return bytes;
    }

    static String stripMm(String v) {
        return v.replace(" mm", "").replace("mm", "").trim();
    }

    static byte[] tailBytes(byte[] line, int from) {
        return from >= line.length ? new byte[0] : slice(line, from, line.length);
    }

    static byte[] slice(byte[] src, int from, int to) {
        int end = Math.min(to, src.length);
        byte[] out = new byte[Math.max(0, end - from)];
        for (int i = 0; i < out.length; i++) {
            out[i] = src[from + i];
        }
        return out;
    }
}
