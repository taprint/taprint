// SPDX-License-Identifier: Apache-2.0
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

// ZPL 标签命令构造器（纯字节拼装层，无副作用、不碰传输）。
// 参照：Java ZplRenderer（v0.2 内置字库路由，ADR-0001——CJK 位图路由 ^GFA
// 留给 v0.2.x 增量，本面不发）与 TS ZplBuilder（同参照移植）。
//
// 口径出处：
// - 帧骨架 `^XA^LH0,0^PW<w>^LL<h> → 元素 → [^PQ<n>] → ^XZ`（^PQ 仅份数 >1 时发）；
// - 文本逐行 `^FOx,y^A0N,h,h^FD<escaped>^FS`，h = 28 × 倍率（域 1-10），行距 = 字高；
// - 一维码 `^FOx,y^BY2,3,<h>` + 码制指令 + `^FD^FS`（全表映射含未知折 CODE128——
//   Java 参照 Symbology.of 口径）；
// - QR `^FOx,y^BQN,2,<size>^FDMA,<data>^FS`（MA 前缀 = 纠错 M + 掩码自动，size 域 1-10）；
// - 线/框 `^FOx,y^GB<w>,<h>,2^FS`（线 = 细框，线高下夹厚度）；
// - ^FD 域转义：反斜杠先行，^ ~ → \^ \~（ZPL II 指令前缀子集）。
// 内容通道：GBK 表 + U+FFFD 占位（ADR-0009 §3）由调用方注入的 Encoding 承担
// ——注入 GBK/GB18030 时表外字符替换策略归引擎侧（Java 参照 GbEncoding 同纪律），
// 构造器层不做码表判定。dot 折算：8 dot/mm（203dpi 工程值；Java 参照 203/25.4
// ≈7.9921，非整点坐标中点差异登记 conformance.md Z 段）。
namespace Taprint.PrintDsl
{
    /// <summary>ZPL 标签元素（绝对坐标 mm；M2 面 = text/barcode/qrcode/line/rect）。</summary>
    public sealed class ZplLabelElement
    {
        internal ZplLabelElement(string type, string content, double xMm, double yMm,
            double widthMm, double heightMm, string symbology, int? size)
        {
            Type = type;
            Content = content;
            XMm = xMm;
            YMm = yMm;
            WidthMm = widthMm;
            HeightMm = heightMm;
            Symbology = symbology;
            Size = size;
        }

        /// <summary>元素类型（text/barcode/qrcode/line/rect）。</summary>
        public string Type { get; }

        /// <summary>text/barcode/qrcode 内容。</summary>
        public string Content { get; }

        /// <summary>x 坐标 mm。</summary>
        public double XMm { get; }

        /// <summary>y 坐标 mm。</summary>
        public double YMm { get; }

        /// <summary>宽 mm（line/rect）。</summary>
        public double WidthMm { get; }

        /// <summary>高 mm（line/barcode 条高/rect）。</summary>
        public double HeightMm { get; }

        /// <summary>条码体系。</summary>
        public string Symbology { get; }

        /// <summary>字号/QR 单元域。</summary>
        public int? Size { get; }

        /// <summary>文本元素（size = 字号倍率，缺省 1）。</summary>
        public static ZplLabelElement Text(string content, double xMm, double yMm, int? size = null)
        {
            return new ZplLabelElement("text", content ?? string.Empty, xMm, yMm, 0, 0, "CODE128", size);
        }

        /// <summary>一维码元素（heightMm = 条高，白名单全表映射见 SymbologyCommand）。</summary>
        public static ZplLabelElement Barcode(string content, string symbology,
            double xMm, double yMm, double heightMm)
        {
            return new ZplLabelElement("barcode", content ?? string.Empty, xMm, yMm, 0, heightMm,
                string.IsNullOrEmpty(symbology) ? "CODE128" : symbology, null);
        }

        /// <summary>QR 元素（size = 单元域 1-10）。</summary>
        public static ZplLabelElement QrCode(string content, double xMm, double yMm, int size)
        {
            return new ZplLabelElement("qrcode", content ?? string.Empty, xMm, yMm, 0, 0, "CODE128", size);
        }

        /// <summary>线元素（widthMm = 线长、heightMm = 线高/折算厚度源）。</summary>
        public static ZplLabelElement Line(double xMm, double yMm, double widthMm, double heightMm)
        {
            return new ZplLabelElement("line", string.Empty, xMm, yMm, widthMm, heightMm, "CODE128", null);
        }

        /// <summary>框元素（widthMm/heightMm = 框全尺寸）。</summary>
        public static ZplLabelElement Rect(double xMm, double yMm, double widthMm, double heightMm)
        {
            return new ZplLabelElement("rect", string.Empty, xMm, yMm, widthMm, heightMm, "CODE128", null);
        }
    }

    /// <summary>
    /// ZPL 标签命令构造器纯函数层：帧头/文本/一维码/QR/框线/份数/收尾——
    /// 全部无副作用可单测（字节序列冻结断言）。内容编码注入（引擎侧 GB18030，
    /// 与 TSPL/CPCL 构造器同纪律）。
    /// </summary>
    public static class ZplBuilder
    {
        /// <summary>^A0 内置字库基准字高（dot）——Java 参照 ASCII_FONT_HEIGHT 同口径。</summary>
        public const int AsciiFontHeightDots = 28;

        /// <summary>线/框厚度缺省（dot）——Java 参照 BOX_THICKNESS 同档。</summary>
        public const int BoxThicknessDots = 2;

        /// <summary>缺省点密度：8 dot/mm（203dpi 标签机折算口径）。</summary>
        public const double DotsPerMmDefault = 8d;

        /// <summary>
        /// mm → 点阵折算（ADR-0009 钉死口径：中点远离零——.NET 默认 Math.Round 为
        /// 银行家舍入（2.5→2），与 Java/TS/Dart 端半值口径不一致即字节漂移，故显式
        /// MidpointRounding.AwayFromZero）。
        /// </summary>
        public static int MmToDots(double millimetres, double dotsPerMm = DotsPerMmDefault)
        {
            return (int)Math.Round(millimetres * dotsPerMm, MidpointRounding.AwayFromZero);
        }

        /// <summary>
        /// 帧头 `^XA^LH0,0^PW{w}^LL{h}`：建立原点左上的点阵坐标系并声明画幅
        /// （宽度/高度 dot，非负夹 0——负画幅无设备语义）。
        /// </summary>
        public static byte[] FrameHeader(int widthDots, int heightDots)
        {
            return Ascii("^XA^LH0,0^PW" + Num(widthDots) + "^LL" + Num(heightDots));
        }

        /// <summary>字段原点 `^FOx,y`（非负夹 0）。</summary>
        public static byte[] FieldOrigin(int xDots, int yDots)
        {
            return Ascii("^FO" + Num(xDots) + "," + Num(yDots));
        }

        /// <summary>
        /// 单行文本 `^A0N,h,h^FD{escaped}^FS`（须先接 FieldOrigin；内容为空返回
        /// 空段——空域不发帧）。fontHeightDots ≤0 时取基准字高。
        /// </summary>
        public static byte[] TextLine(string content, Encoding textEncoding, int fontHeightDots = AsciiFontHeightDots)
        {
            if (textEncoding == null)
            {
                throw new ArgumentNullException(nameof(textEncoding));
            }

            if (string.IsNullOrEmpty(content))
            {
                return Empty();
            }

            int h = Math.Max(1, fontHeightDots);
            return Compose(
                Ascii("^A0N," + h + "," + h + "^FD"),
                textEncoding.GetBytes(EscapeFieldData(content)),
                Ascii("^FS"));
        }

        /// <summary>^FD 域转义：反斜杠先行 → \\，指令前缀 ^ ~ → \^ \~。</summary>
        public static string EscapeFieldData(string text)
        {
            if (string.IsNullOrEmpty(text))
            {
                return string.Empty;
            }

            var builder = new StringBuilder(text.Length);
            foreach (char c in text)
            {
                if (c == '\\' || c == '^' || c == '~')
                {
                    builder.Append('\\');
                }

                builder.Append(c);
            }

            return builder.ToString();
        }

        /// <summary>
        /// 一维码 `^BY{narrow},{ratio},{h}` + 码制指令 + `^FD{escaped}^FS`（须先接
        /// FieldOrigin；内容为空返回空段）。窄条缺省 2 dot、宽窄比缺省 3。
        /// </summary>
        public static byte[] Barcode(string symbology, int heightDots, string content,
            Encoding textEncoding, int narrowDots = 2, int wideToNarrowRatio = 3)
        {
            if (textEncoding == null)
            {
                throw new ArgumentNullException(nameof(textEncoding));
            }

            if (string.IsNullOrEmpty(content))
            {
                return Empty();
            }

            int h = Math.Max(1, heightDots);
            return Compose(
                Ascii("^BY" + Math.Max(1, narrowDots) + "," + Math.Max(1, wideToNarrowRatio) + "," + h),
                Ascii(SymbologyCommand(symbology, h) + "^FD"),
                textEncoding.GetBytes(EscapeFieldData(content)),
                Ascii("^FS"));
        }

        /// <summary>
        /// 码制指令（Java 参照全表）：CODE128/^BCN,h,Y,N,N；EAN13/^BEN,h,Y,N,N；
        /// EAN8/^BEN,h,Y,N；UPC/^BUN,h,Y,N；CODE39/^B3N,N,h,Y,N；ITF/^B2N,h,N,N；
        /// 未知折 CODE128（Symbology.of 缺省口径——与 CPCL 构造器「拒绝抛错」
        /// 纪律不同，差异登记 conformance.md）。
        /// </summary>
        public static string SymbologyCommand(string symbology, int heightDots)
        {
            int h = Math.Max(1, heightDots);
            switch ((symbology ?? string.Empty).Trim().ToUpperInvariant())
            {
                case "EAN13":
                    return "^BEN," + h + ",Y,N,N";
                case "EAN8":
                    return "^BEN," + h + ",Y,N";
                case "UPC":
                case "UPCA":
                    return "^BUN," + h + ",Y,N";
                case "CODE39":
                    return "^B3N,N," + h + ",Y,N";
                case "ITF":
                case "I2OF5":
                    return "^B2N," + h + ",N,N";
                default:
                    // 含 CODE128 与未知码制：Symbology.of 缺省折 CODE128
                    return "^BCN," + h + ",Y,N,N";
            }
        }

        /// <summary>
        /// QR `^BQN,2,{size}^FDMA,{data}^FS`（须先接 FieldOrigin；内容为空返回空段）。
        /// size 域 1-10 夹取；MA 前缀 = 纠错 M + 掩码自动。
        /// </summary>
        public static byte[] QrCode(int size, string content, Encoding textEncoding)
        {
            if (textEncoding == null)
            {
                throw new ArgumentNullException(nameof(textEncoding));
            }

            if (string.IsNullOrEmpty(content))
            {
                return Empty();
            }

            int n = Clamp(size, 1, 10);
            return Compose(
                Ascii("^BQN,2," + n + "^FDMA,"),
                textEncoding.GetBytes(EscapeFieldData(content)),
                Ascii("^FS"));
        }

        /// <summary>线/框 `^GB{w},{h},{t}`（须先接 FieldOrigin；厚度下限 1）。</summary>
        public static byte[] Box(int widthDots, int heightDots, int thicknessDots = BoxThicknessDots)
        {
            return Ascii("^GB" + Math.Max(1, widthDots) + "," + Math.Max(1, heightDots) + ","
                + Math.Max(1, thicknessDots) + "^FS");
        }

        /// <summary>份数 `^PQ{n}`（n 夹 ≥1；组装层仅在 >1 时发——=1 无 ZPL 帧语义）。</summary>
        public static byte[] PrintQty(int copies)
        {
            return Ascii("^PQ" + Math.Max(1, copies).ToString(CultureInfo.InvariantCulture));
        }

        /// <summary>收尾 `^XZ`。</summary>
        public static byte[] FrameEnd()
        {
            return Ascii("^XZ");
        }

        /// <summary>
        /// 整帧组装（Java 参照帧序）：帧头（画幅 = mm×8 dot）→ 元素（text 多行
        /// 逐行、barcode、qrcode、line/rect → ^GB 细框；未知类型跳过——绝对坐标
        /// 布局无占位语义）→ [^PQ 份数 >1] → ^XZ。
        /// </summary>
        public static byte[] BuildLabel(double widthMm, double heightMm, int copies,
            IEnumerable<ZplLabelElement> body, Encoding textEncoding)
        {
            if (textEncoding == null)
            {
                throw new ArgumentNullException(nameof(textEncoding));
            }

            var parts = new List<byte[]> { FrameHeader(MmToDots(widthMm), MmToDots(heightMm)) };
            if (body != null)
            {
                foreach (ZplLabelElement el in body)
                {
                    AppendElement(parts, el, textEncoding);
                }
            }

            int qty = Math.Max(1, copies);
            if (qty > 1)
            {
                parts.Add(PrintQty(qty));
            }

            parts.Add(FrameEnd());
            return Concat(parts);
        }

        private static void AppendElement(List<byte[]> parts, ZplLabelElement el, Encoding textEncoding)
        {
            int x = MmToDots(el.XMm);
            int y = MmToDots(el.YMm);
            switch (el.Type)
            {
                case "text":
                {
                    string content = el.Content ?? string.Empty;
                    if (content.Length == 0)
                    {
                        break;
                    }

                    int mul = el.Size.HasValue ? Clamp(el.Size.Value == 0 ? 1 : el.Size.Value, 1, 10) : 1;
                    int h = AsciiFontHeightDots * mul;
                    string[] lines = content.Split('\n');
                    for (int lineNo = 0; lineNo < lines.Length; lineNo++)
                    {
                        parts.Add(FieldOrigin(x, y + lineNo * h));
                        parts.Add(TextLine(lines[lineNo], textEncoding, h));
                    }

                    break;
                }
                case "barcode":
                {
                    if (string.IsNullOrEmpty(el.Content))
                    {
                        break;
                    }

                    parts.Add(FieldOrigin(x, y));
                    parts.Add(Barcode(el.Symbology, MmToDots(el.HeightMm), el.Content, textEncoding));
                    break;
                }
                case "qrcode":
                {
                    if (string.IsNullOrEmpty(el.Content))
                    {
                        break;
                    }

                    parts.Add(FieldOrigin(x, y));
                    parts.Add(QrCode(el.Size ?? 6, el.Content, textEncoding));
                    break;
                }
                case "line":
                {
                    // 线高 = height 折算下夹厚度（零高度框无 ZPL 语义）
                    int stroke = Math.Max(BoxThicknessDots, MmToDots(el.HeightMm));
                    parts.Add(FieldOrigin(x, y));
                    parts.Add(Box(MmToDots(el.WidthMm), stroke));
                    break;
                }
                case "rect":
                    parts.Add(FieldOrigin(x, y));
                    parts.Add(Box(MmToDots(el.WidthMm), MmToDots(el.HeightMm)));
                    break;
                default:
                    break; // 未知元素跳过
            }
        }

        private static byte[] Ascii(string command)
        {
            return Encoding.ASCII.GetBytes(command);
        }

        private static byte[] Empty()
        {
            return new byte[0];
        }

        /// <summary>点阵参数串（非负夹 0——负坐标无设备域意义）。</summary>
        private static string Num(int dots)
        {
            return Math.Max(0, dots).ToString(CultureInfo.InvariantCulture);
        }

        private static int Clamp(int value, int min, int max)
        {
            return value < min ? min : (value > max ? max : value);
        }

        private static byte[] Compose(params byte[][] segments)
        {
            return Concat(segments);
        }

        private static byte[] Concat(IList<byte[]> segments)
        {
            int total = 0;
            foreach (byte[] segment in segments)
            {
                total += segment.Length;
            }

            var frame = new byte[total];
            int offset = 0;
            foreach (byte[] segment in segments)
            {
                Array.Copy(segment, 0, frame, offset, segment.Length);
                offset += segment.Length;
            }

            return frame;
        }
    }
}
