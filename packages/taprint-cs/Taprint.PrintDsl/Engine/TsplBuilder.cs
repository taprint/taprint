// SPDX-License-Identifier: Apache-2.0
#nullable disable
using System;
using System.Globalization;
using System.Text;

namespace Taprint.PrintDsl.Engine
{
    // ============================================================
    // TSPL 标签命令构建器纯函数层（三层架构之「TSPL 通用构建器」——与
    // EscPosBuilder/CPCL 构造器同族：纯字节拼装、无副作用、不碰传输）。
    //
    // 命令口径出处=TSPL/TSPL2 标签打印机编程手册业界通用子集（TSC 系公开文档，
    // 佳博/汉印/芯烨等国产标签机普遍复刻）——【未本机实证，真机窗口核验】。
    //
    // 命令面（冻结集，缺一即测试面违约）：
    //   SIZE width mm,height mm ／ GAP gap mm,blackout mm ／ SPEED n ／ DENSITY n
    //   ／ CLS ／ TEXT x,y,"font",rotation,xmul,ymul,"content"
    //   ／ BARCODE x,y,"symbology",height,human,rotation,narrow,wide,"content"
    //   ／ QRCODE x,y,ecc,cell,mode,rotation,"content" ／ FORMFEED ／ PRINT m
    // 扩展集（黑标/校准/线框底层）：BLINE m mm,blackout mm ／ SET TEAR ON|OFF
    //   ／ DIRECTION n ／ BAR x,y,width,height ／ BOX x,y,width,height,thickness
    //   ——同一出处口径，同样【未本机实证，真机窗口核验】（黑标 BLINE 帧挂黑标纸实测）。
    // 每命令 CR LF（0x0D 0x0A）收尾（手册通例）；参数算术=203dpi 点阵（8 dot/mm，
    // 与 DslDimension.DotsPerMm 同口径）——mm→dot 折算归装载器，本层只收点阵整数。
    //
    // 文本段编码由调用方注入（引擎侧 GB18030——与 EscPosTicketEngine.ResolveGb18030
    // 同款纪律）；内容清洗=引号/换行剔除（TSPL 引号串无转义文法，帧结构字符混入即
    // 碎裂）；条码内容另过 ASCII 域清洗（码制字符域=可见 ASCII）。
    // ============================================================
    // ============================================================
    /// <summary>
    /// TSPL 标签命令构建器纯函数层：纸面/间隙/速度/浓度/文本/条码/二维码/线框/
    /// 份数收尾命令——每命令 CR LF 收尾、内容段编码由调用方注入（引擎侧 GB18030），
    /// 全部无副作用可单测（字节序列冻结断言），不碰传输。
    /// </summary>
    public static class TsplBuilder
    {
        /// <summary>命令行收尾（手册通例：每命令以 CR LF 结束）。</summary>
        public const string LineTerminator = "\r\n";

        /// <summary>标签间隙遮蔽段缺省（GAP 第二参数 0 mm——无遮蔽标定，样例通例）。</summary>
        public const double GapBlackoutMm = 0d;

        /// <summary>
        /// 纸面尺寸 SIZE width mm,height mm。画布物理面——坐标原点左上，
        /// 出参毫米单位（装载器持有的 mm 值直承，dot 换算只用于元素坐标）。
        /// </summary>
        public static byte[] Size(double widthMm, double heightMm)
        {
            return Ascii("SIZE " + FormatMm(widthMm) + " mm," + FormatMm(heightMm) + " mm" + LineTerminator);
        }

        /// <summary>黑标定位 BLINE m mm,blackout mm（m=黑标线高；gapType=black 纸型用——
        /// 与 GAP 二选一；真机标定项=黑标纸实测）。</summary>
        public static byte[] BLine(double blineMm)
        {
            return Ascii("BLINE " + FormatMm(blineMm) + " mm," + FormatMm(GapBlackoutMm) + " mm" + LineTerminator);
        }

        /// <summary>撕纸位送纸 SET TEAR ON|OFF（on=印后送到撕纸位；设备键 labelTear）。</summary>
        public static byte[] SetTear(bool on)
        {
            return Ascii("SET TEAR " + (on ? "ON" : "OFF") + LineTerminator);
        }

        /// <summary>出图方向 DIRECTION n（0=原点左上不旋转；rotation 支持前的档位面，
        /// 预留不发射——引擎仅在设备参数 Direction 有值时入帧，帧序断言经此触发）。</summary>
        public static byte[] Direction(int direction)
        {
            return Ascii("DIRECTION " + Clamp(direction, 0, 3).ToString(CultureInfo.InvariantCulture) + LineTerminator);
        }

        /// <summary>实心矩形/粗线 BAR x,y,width,height（分割线/粗线=单形承载；元素映射挂 DSL line/box）。</summary>
        public static byte[] Bar(int xDots, int yDots, int widthDots, int heightDots)
        {
            return Ascii("BAR " + Dot(xDots) + "," + Dot(yDots) + "," +
                Math.Max(0, widthDots).ToString(CultureInfo.InvariantCulture) + "," +
                Math.Max(0, heightDots).ToString(CultureInfo.InvariantCulture) + LineTerminator);
        }

        /// <summary>线框 BOX x,y,width,height,thickness（五参帧；元素映射挂 DSL box）。</summary>
        public static byte[] Box(int xDots, int yDots, int widthDots, int heightDots, int thicknessDots)
        {
            return Ascii("BOX " + Dot(xDots) + "," + Dot(yDots) + "," +
                Math.Max(0, widthDots).ToString(CultureInfo.InvariantCulture) + "," +
                Math.Max(0, heightDots).ToString(CultureInfo.InvariantCulture) + "," +
                Math.Max(1, thicknessDots).ToString(CultureInfo.InvariantCulture) + LineTerminator);
        }

        /// <summary>标签间隙 GAP gap mm,blackout mm（黑标定位间隙缺省 0——非黑标纸通例）。</summary>
        public static byte[] Gap(double gapMm)
        {
            return Ascii("GAP " + FormatMm(gapMm) + " mm," + FormatMm(GapBlackoutMm) + " mm" + LineTerminator);
        }

        /// <summary>打印速度 SPEED n（英寸/秒档位，1-10——schema speed 界）。</summary>
        public static byte[] Speed(int speed)
        {
            return Ascii("SPEED " + Clamp(speed, 1, 10).ToString(CultureInfo.InvariantCulture) + LineTerminator);
        }

        /// <summary>打印浓度 DENSITY n（0-15——schema density 界）。</summary>
        public static byte[] Density(int density)
        {
            return Ascii("DENSITY " + Clamp(density, 0, 15).ToString(CultureInfo.InvariantCulture) + LineTerminator);
        }

        /// <summary>清打印缓冲 CLS（每帧首置——残留缓冲即重影，手册通例）。</summary>
        public static byte[] Cls()
        {
            return Ascii("CLS" + LineTerminator);
        }

        /// <summary>
        /// 文本 TEXT x,y,"font",rotation,xmul,ymul,"content"。
        /// font=字库名（"SIMPLIFIED CHINESE" 中文简体字库——设计器样例通例）；
        /// rotation 0=不旋转；xmul/ymul 1-10 放大倍率（schema text.size 0-10 口径）；
        /// content 经编码注入（中文 GB18030）。
        /// </summary>
        public static byte[] Text(int xDots, int yDots, string fontName, int rotation,
            int xMultiplication, int yMultiplication, string content, Encoding textEncoding)
        {
            if (textEncoding == null)
            {
                throw new ArgumentNullException("textEncoding");
            }

            string prefix = "TEXT " + Dot(xDots) + "," + Dot(yDots) + ",\"" + SafeToken(fontName) + "\"," +
                Clamp(rotation, 0, 3).ToString(CultureInfo.InvariantCulture) + "," +
                Clamp(xMultiplication, 1, 10).ToString(CultureInfo.InvariantCulture) + "," +
                Clamp(yMultiplication, 1, 10).ToString(CultureInfo.InvariantCulture) + ",\"";
            return Compose(prefix, EncodeContent(content, textEncoding), "\"" + LineTerminator);
        }

        /// <summary>
        /// 条码 BARCODE x,y,"symbology",height,human,rotation,narrow,wide,"content"。
        /// human=1 附人读字符/2 不附（1 为主参，价签场景附读）；height 单位 dot；
        /// narrow/wide 单位 dot（窄宽条宽，2/2 为通例缺省——码制比例由打印机内建）。
        /// content 限可见 ASCII（码制字符域）。
        /// </summary>
        public static byte[] Barcode(int xDots, int yDots, string symbology, int heightDots,
            bool humanReadable, int rotation, int narrowDots, int wideDots, string content)
        {
            string prefix = "BARCODE " + Dot(xDots) + "," + Dot(yDots) + ",\"" + SafeToken(symbology) + "\"," +
                Math.Max(1, heightDots).ToString(CultureInfo.InvariantCulture) + "," +
                (humanReadable ? "1" : "2") + "," +
                Clamp(rotation, 0, 3).ToString(CultureInfo.InvariantCulture) + "," +
                Math.Max(1, narrowDots).ToString(CultureInfo.InvariantCulture) + "," +
                Math.Max(1, wideDots).ToString(CultureInfo.InvariantCulture) + ",\"";
            return Compose(prefix, EncodeContent(AsciiSafe(content), Encoding.ASCII), "\"" + LineTerminator);
        }

        /// <summary>
        /// 二维码 QRCODE x,y,ecc,cell,mode,rotation,"content"。
        /// ecc=M（Epson/TSPL 双面通例中检纠错档）；cell=模块格边长 dot（1-10——
        /// schema qrcode.size 1-20 折 TSPL 域夹 10，装载器完成）；mode=0（原码模式）。
        /// content 编码注入（中文 GB18030——QR 承载 CJK 码字，真机核验项）。
        /// </summary>
        public static byte[] QrCode(int xDots, int yDots, string eccLevel, int cellWidthDots,
            int mode, int rotation, string content, Encoding textEncoding)
        {
            if (textEncoding == null)
            {
                throw new ArgumentNullException("textEncoding");
            }

            string prefix = "QRCODE " + Dot(xDots) + "," + Dot(yDots) + "," + SafeToken(eccLevel) + "," +
                Clamp(cellWidthDots, 1, 10).ToString(CultureInfo.InvariantCulture) + "," +
                mode.ToString(CultureInfo.InvariantCulture) + "," +
                Clamp(rotation, 0, 3).ToString(CultureInfo.InvariantCulture) + ",\"";
            return Compose(prefix, EncodeContent(content, textEncoding), "\"" + LineTerminator);
        }

        /// <summary>走纸到下一张标签原点 FORMFEED（校准/走纸链用——PRINT 后追加会多走
        /// 一张空白（真机实测定谳），常规帧尾禁带，见 TsplLabelEngine 帧序注释）。</summary>
        public static byte[] FormFeed()
        {
            return Ascii("FORMFEED" + LineTerminator);
        }

        /// <summary>打印 PRINT m（m=同帧复打份数——份数语义单帧承载，禁客户端逐份循环重发）。</summary>
        public static byte[] Print(int copies)
        {
            return Ascii("PRINT " + Math.Max(1, copies).ToString(CultureInfo.InvariantCulture) + LineTerminator);
        }

        /// <summary>内容段编码：清洗帧结构字符（引号/CR/LF）后按指定编码落字节。</summary>
        public static byte[] EncodeContent(string content, Encoding encoding)
        {
            if (encoding == null)
            {
                throw new ArgumentNullException("encoding");
            }

            return encoding.GetBytes(Sanitize(content));
        }

        /// <summary>引号串内容清洗（TSPL 引号串无转义文法——帧结构字符一律剔除，防命令碎裂）。</summary>
        internal static string Sanitize(string content)
        {
            if (string.IsNullOrEmpty(content))
            {
                return string.Empty;
            }

            var builder = new StringBuilder(content.Length);
            for (int i = 0; i < content.Length; i++)
            {
                char c = content[i];
                if (c == '"' || c == '\r' || c == '\n')
                {
                    continue;
                }

                builder.Append(c);
            }

            return builder.ToString();
        }

        /// <summary>码内容 ASCII 域清洗（非可见 ASCII 降 '?'）。</summary>
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

        /// <summary>引号外裸词清洗（字库名/码制名/纠错档——仅字母数字空格，其余剔除）。</summary>
        private static string SafeToken(string token)
        {
            string raw = Sanitize(token);
            var builder = new StringBuilder(raw.Length);
            for (int i = 0; i < raw.Length; i++)
            {
                char c = raw[i];
                if (char.IsLetterOrDigit(c) || c == ' ')
                {
                    builder.Append(c);
                }
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

        /// <summary>点阵参数串（非负夹 0——负坐标无设备域意义）。</summary>
        private static string Dot(int dots)
        {
            return Math.Max(0, dots).ToString(CultureInfo.InvariantCulture);
        }

        private static int Clamp(int value, int min, int max)
        {
            return value < min ? min : (value > max ? max : value);
        }

        /// <summary>毫米整形化（70 不发 "70.0"——SIZE/GAP 参数形态确定性，字节冻结前提；
        /// ADR-0009 数值规范：禁平台默认浮点转串（最短表示/15 位有效数字变体））。</summary>
        private static string FormatMm(double valueMm)
        {
            double value = valueMm > 0d ? valueMm : 0d;
            return value == Math.Floor(value) && !double.IsInfinity(value)
                ? ((long)value).ToString(CultureInfo.InvariantCulture)
                : value.ToString(CultureInfo.InvariantCulture);
        }
    }
}
