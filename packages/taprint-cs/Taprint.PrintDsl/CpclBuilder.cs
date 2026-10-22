// SPDX-License-Identifier: Apache-2.0
using System;
using System.Globalization;
using System.Text;

// CPCL 便携标签机命令构造器（纯字节拼装层，无副作用、不碰传输）。
// 口径出处=Zebra CPCL 编程手册业界通用子集，国产便携标签机（移动蓝牙小标签机
// 一类）普遍复刻——具体型号方言差异属真机窗口核验项（见 ADR-0006 清史纪律），
// 未本机实证处以注释逐条登记。
// 双参照移植：服务端 Java CPCL 渲染器（CRLF 行尾、TEXT/BARCODE 参数序、QR 三段式、
// CR/LF 清洗）与移动端 Dart CPCL 编码器（内容编码注入、码制白名单、份数入格式头）。
// 与 TSPL 构造器（TsplBuilder 同族）的分工：TSPL 以逗号分隔参数、mm 直接入命令；
// CPCL 以空格分隔参数、全部点阵坐标，mm→dot 折算由本层 MmToDots 显式承担
// （ADR-0009：中点远离零舍入，禁止平台默认银行家舍入）。
//
// 坐标系：格式头 `! offset horz vert height qty` 建立原点左上的绝对点阵坐标系，
// horz/vert 为横向/纵向 DPI（通例 200/200 = 8 dot/mm 工程值）；height 为标签高
// 点数；qty 为打印份数（份数语义单帧承载，禁客户端逐份循环重发——与 TSPL 同纪律）。
namespace Taprint.PrintDsl
{
    /// <summary>CPCL 文本/条码对齐档（LEFT/CENTER/RIGHT 三命令，作用于后续行）。</summary>
    public enum CpclAlignment
    {
        /// <summary>左对齐（缺省档）。</summary>
        Left = 0,

        /// <summary>居中（后续 TEXT/BARCODE 按行宽居中）。</summary>
        Center = 1,

        /// <summary>右对齐。</summary>
        Right = 2,
    }

    /// <summary>
    /// CPCL 标签命令构造器纯函数层：格式头/文本/一维码/QR 三段式/线框/对齐/切纸/
    /// 收尾帧——每命令以 CR LF 收尾（手册通例），内容段编码由调用方注入
    /// （引擎侧 GB18030，与 TSPL 构造器同纪律），全部无副作用可单测（字节序列冻结断言）。
    /// </summary>
    public static class CpclBuilder
    {
        /// <summary>命令行收尾（手册通例：每命令以 CR LF 结束；Java 渲染器同口径，
        /// Dart 编码器为裸 LF——以带 CR 形态冻结，真机差异=窗口核验登记项）。</summary>
        public const string LineTerminator = "\r\n";

        /// <summary>缺省点密度：200 DPI 工程值 8 dot/mm（格式头 horz/vert=200 对应）。</summary>
        public const double DotsPerMmDefault = 8d;

        /// <summary>文本缺省字库号 4（横向可缩放位图字库，两参照一致采用）。</summary>
        public const int DefaultTextFont = 4;

        /// <summary>一维码窄条宽缺省 2 dot、宽窄比缺省 1（两参照一致采用）。</summary>
        public const int DefaultBarcodeNarrowWidthDots = 2;

        /// <summary>
        /// mm → 点阵折算（ADR-0009 钉死口径：中点远离零——.NET 默认 Math.Round 为
        /// 银行家舍入（2.5→2），与 Java/Dart 端半值口径不一致即字节漂移，故显式
        /// MidpointRounding.AwayFromZero；多语言 golden 中点夹具按本口径冻结）。
        /// dotsPerMm 由设备 DPI 派生（200→8.0 工程/300→11.811）。
        /// </summary>
        public static int MmToDots(double millimetres, double dotsPerMm = DotsPerMmDefault)
        {
            return (int)Math.Round(millimetres * dotsPerMm, MidpointRounding.AwayFromZero);
        }

        /// <summary>
        /// 格式头（坐标系指令）`! offset horz vert height qty`：
        /// 建立原点左上的绝对点阵坐标系并声明标签高与份数。
        /// height 单位 dot（mm 调用方经 MmToDots 折算）；qty 夹 ≥1。
        /// </summary>
        public static byte[] FormatHeader(int heightDots, int quantity,
            int offsetDots = 0, int horizontalDpi = 200, int verticalDpi = 200)
        {
            return Ascii("! " + Num(offsetDots) + " " + Math.Max(1, horizontalDpi).ToString(CultureInfo.InvariantCulture)
                + " " + Math.Max(1, verticalDpi).ToString(CultureInfo.InvariantCulture)
                + " " + Math.Max(1, heightDots).ToString(CultureInfo.InvariantCulture)
                + " " + Math.Max(1, quantity).ToString(CultureInfo.InvariantCulture) + LineTerminator);
        }

        /// <summary>
        /// 文本 `TEXT font size x y content`——内容不带引号、行尾结束（CPCL 文法，
        /// 与 TSPL 引号串不同：帧结构字符是 CR/LF 而非引号，清洗见 Sanitize）。
        /// font=字库号（缺省 4 位图字库）；size=放大档 0-7（位图字库纵向放大减一档，
        /// Java 渲染器口径）；内容编码注入（CJK 由引擎侧 GB18030 承载，Dart 编码器同径）。
        /// </summary>
        public static byte[] Text(int font, int size, int xDots, int yDots,
            string? content, Encoding textEncoding)
        {
            if (textEncoding == null)
            {
                throw new ArgumentNullException(nameof(textEncoding));
            }

            string prefix = "TEXT " + Clamp(font, 0, 7).ToString(CultureInfo.InvariantCulture)
                + " " + Clamp(size, 0, 7).ToString(CultureInfo.InvariantCulture)
                + " " + Num(xDots) + " " + Num(yDots) + " ";
            return Compose(prefix, textEncoding.GetBytes(Sanitize(content)), LineTerminator);
        }

        /// <summary>
        /// 一维码 `BARCODE type width ratio height x y content`——内容不带引号、
        /// 行尾结束。type 为 CPCL 助记符（MapSymbology 从通用码制名折算）；
        /// width=窄条宽 dot、ratio=宽窄比；height 单位 dot。内容限可见 ASCII 码制字符域。
        /// </summary>
        public static byte[] Barcode(string symbology, int heightDots, int xDots, int yDots,
            string? content, int narrowWidthDots = DefaultBarcodeNarrowWidthDots, int wideToNarrowRatio = 1)
        {
            string type = MapSymbology(symbology);
            string prefix = "BARCODE " + type
                + " " + Math.Max(1, narrowWidthDots).ToString(CultureInfo.InvariantCulture)
                + " " + Math.Max(1, wideToNarrowRatio).ToString(CultureInfo.InvariantCulture)
                + " " + Math.Max(1, heightDots).ToString(CultureInfo.InvariantCulture)
                + " " + Num(xDots) + " " + Num(yDots) + " ";
            return Compose(prefix, Encoding.ASCII.GetBytes(AsciiSafe(Sanitize(content))), LineTerminator);
        }

        /// <summary>
        /// 码制名 → CPCL 助记符（白名单映射）：CODE128→128、EAN13/EAN8 直通、
        /// UPC→UPCA、CODE39→39、ITF→I2OF5（Java 渲染器全表口径，覆盖 Dart 编码器
        /// 的 CODE128/EAN13 子集）；白名单外抛 ArgumentException——调用方按业务
        /// 决定拒绝不印，禁止静默改码制。
        /// </summary>
        public static string MapSymbology(string symbology)
        {
            switch ((symbology ?? string.Empty).Trim().ToUpperInvariant())
            {
                case "CODE128":
                    return "128";
                case "EAN13":
                    return "EAN13";
                case "EAN8":
                    return "EAN8";
                case "UPC":
                case "UPCA":
                    return "UPCA";
                case "CODE39":
                    return "39";
                case "ITF":
                    return "I2OF5";
                default:
                    throw new ArgumentException(
                        "CPCL 码制白名单外: " + (symbology ?? "null"), nameof(symbology));
            }
        }

        /// <summary>
        /// 人读字符 `BARCODE-TEXT font size x y content`（HRI 开关开时紧跟一维码帧
        /// 补一行可读文本；字距真机校准项）。内容编码注入。
        /// </summary>
        public static byte[] BarcodeText(int font, int size, int xDots, int yDots,
            string? content, Encoding textEncoding)
        {
            if (textEncoding == null)
            {
                throw new ArgumentNullException(nameof(textEncoding));
            }

            string prefix = "BARCODE-TEXT " + Clamp(font, 0, 7).ToString(CultureInfo.InvariantCulture)
                + " " + Clamp(size, 0, 7).ToString(CultureInfo.InvariantCulture)
                + " " + Num(xDots) + " " + Num(yDots) + " ";
            return Compose(prefix, textEncoding.GetBytes(Sanitize(content)), LineTerminator);
        }

        /// <summary>
        /// QR 三段式（手册权威口径，禁按单行式实现）：
        /// 段 1 `BARCODE QR x y M 2 U unit`（M=QR 型号 2 官方缺省，非纠错档；
        /// U=单元大小 dot，夹 1-32）；段 2 数据行三字符形态 `M0A,data`
        /// （ECC=M 掩码=0 模式=A 自动——两字符 MA, 形态真机校准前不出）；
        /// 段 3 `ENDQR` 收口。内容编码注入（QR 承载 CJK 码字）。
        /// </summary>
        public static byte[] QrCode(int xDots, int yDots, int unitDots,
            string? content, Encoding textEncoding)
        {
            if (textEncoding == null)
            {
                throw new ArgumentNullException(nameof(textEncoding));
            }

            byte[] head = Ascii("BARCODE QR " + Num(xDots) + " " + Num(yDots) + " M 2 U "
                + Clamp(unitDots, 1, 32).ToString(CultureInfo.InvariantCulture) + LineTerminator
                + "M0A,");
            byte[] body = textEncoding.GetBytes(Sanitize(content));
            byte[] tail = Ascii(LineTerminator + "ENDQR" + LineTerminator);
            var frame = new byte[head.Length + body.Length + tail.Length];
            Array.Copy(head, 0, frame, 0, head.Length);
            Array.Copy(body, 0, frame, head.Length, body.Length);
            Array.Copy(tail, 0, frame, head.Length + body.Length, tail.Length);
            return frame;
        }

        /// <summary>直线 `LINE x0 y0 x1 y1 thickness`——thickness 夹 ≥1
        /// （Java 渲染器通例档 2；Dart 编码器按元素高度折厚，取值归调用方）。</summary>
        public static byte[] Line(int x0Dots, int y0Dots, int x1Dots, int y1Dots, int thicknessDots)
        {
            return Ascii("LINE " + Num(x0Dots) + " " + Num(y0Dots) + " " + Num(x1Dots) + " "
                + Num(y1Dots) + " " + Math.Max(1, thicknessDots).ToString(CultureInfo.InvariantCulture)
                + LineTerminator);
        }

        /// <summary>线框 `BOX x0 y0 x1 y1 thickness`（Java 渲染器口径；thickness 夹 ≥1）。</summary>
        public static byte[] Box(int x0Dots, int y0Dots, int x1Dots, int y1Dots, int thicknessDots)
        {
            return Ascii("BOX " + Num(x0Dots) + " " + Num(y0Dots) + " " + Num(x1Dots) + " "
                + Num(y1Dots) + " " + Math.Max(1, thicknessDots).ToString(CultureInfo.InvariantCulture)
                + LineTerminator);
        }

        /// <summary>对齐档 `LEFT|CENTER|RIGHT`——作用于后续 TEXT/BARCODE 行
        /// （绝对坐标布局下仅对省略坐标的行生效，真机核验登记项）。</summary>
        public static byte[] Align(CpclAlignment alignment)
        {
            string token;
            switch (alignment)
            {
                case CpclAlignment.Center:
                    token = "CENTER";
                    break;
                case CpclAlignment.Right:
                    token = "RIGHT";
                    break;
                default:
                    token = "LEFT";
                    break;
            }

            return Ascii(token + LineTerminator);
        }

        /// <summary>切纸 `CUT`（带自动切刀机型；无切刀机型多数静默忽略或仅走纸——
        /// 真机差异=窗口核验登记项）。</summary>
        public static byte[] Cut()
        {
            return Ascii("CUT" + LineTerminator);
        }

        /// <summary>收尾帧 FORM：印完本格式送出到下一标签定位。</summary>
        public static byte[] Form()
        {
            return Ascii("FORM" + LineTerminator);
        }

        /// <summary>收尾帧 PRINT：本格式即刻出标签（与 FORM 成对收口，份数已在格式头承载）。</summary>
        public static byte[] Print()
        {
            return Ascii("PRINT" + LineTerminator);
        }

        /// <summary>
        /// 内容清洗（CPCL 内容不带引号、行尾结束——CR/LF 混入即碎帧）：
        /// CR/LF 替换为空格（Java 渲染器口径：保留间隔语义而非剔除）。
        /// 输入 null 视为空串。
        /// </summary>
        internal static string Sanitize(string? content)
        {
            if (content == null || content.Length == 0)
            {
                return string.Empty;
            }

            return content.Replace("\r", " ").Replace("\n", " ");
        }

        /// <summary>码内容 ASCII 域清洗（非可见 ASCII 降 '?'——码制字符域约束，
        /// 与 TSPL 构造器同语义）。</summary>
        internal static string AsciiSafe(string content)
        {
            if (string.IsNullOrEmpty(content))
            {
                return string.Empty;
            }

            var builder = new StringBuilder(content.Length);
            for (int i = 0; i < content.Length; i++)
            {
                char c = content[i];
                builder.Append(c >= 0x20 && c <= 0x7E ? c : '?');
            }

            return builder.ToString();
        }

        private static byte[] Compose(string asciiPrefix, byte[] encodedBody, string asciiSuffix)
        {
            byte[] prefix = Encoding.ASCII.GetBytes(asciiPrefix);
            byte[] suffix = Encoding.ASCII.GetBytes(asciiSuffix);
            var frame = new byte[prefix.Length + encodedBody.Length + suffix.Length];
            Array.Copy(prefix, 0, frame, 0, prefix.Length);
            Array.Copy(encodedBody, 0, frame, prefix.Length, encodedBody.Length);
            Array.Copy(suffix, 0, frame, prefix.Length + encodedBody.Length, suffix.Length);
            return frame;
        }

        private static byte[] Ascii(string command)
        {
            return Encoding.ASCII.GetBytes(command);
        }

        /// <summary>点阵坐标参数串（非负夹 0——负坐标无设备域意义）。</summary>
        private static string Num(int dots)
        {
            return Math.Max(0, dots).ToString(CultureInfo.InvariantCulture);
        }

        private static int Clamp(int value, int min, int max)
        {
            return value < min ? min : (value > max ? max : value);
        }
    }
}
