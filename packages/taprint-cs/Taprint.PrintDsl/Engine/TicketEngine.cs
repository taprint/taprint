// SPDX-License-Identifier: Apache-2.0
#nullable disable
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Threading;

namespace Taprint.PrintDsl.Engine
{
    // ============================================================
    // ESC/POS 出票引擎（主路）：PrintTicketIr → 送打字节流。
    //
    // 字节命令全数骑 EscPosBuilder 只读消费（禁改本体——构建器/引擎分工）：
    //   Initialize/LineFeed/FeedLines/CutPaper/EncodeText(GB18030)/ToHex。
    // 引擎自持命令（EscPosBuilder 无对应构造面，出处=ESC/POS 公开指令规范，
    // 与 EscPosBuilder 同源口径）：
    //   - GS ! n 双倍宽高/复原、ESC a n 对齐三档；
    //   - GS ( k 二维码（model 2, module size, ECC M）；GS k m 条码 CODE128/B 系；
    //   - 制表对齐行按列预算空格填充（CJK 双宽折算，与 IR 列数一致）。
    // 中文编码走 GB18030 超集（仓统一纪律——EscPosBuilder.EncodeText 同口径），
    // CodePages 提供程序注册收口引擎静态初始化单点。
    // ============================================================

    /// <summary>出票引擎 seam：IR → 设备方言字节（esc-pos 主路；驱动路由 SpoolerTicketChannel 承担）。</summary>
    public interface ITicketEngine
    {
        /// <summary>方言标识（渲染契约 commandSet 取值风格）。</summary>
        string CommandSet { get; }

        /// <summary>IR → 送打字节流。</summary>
        byte[] Build(PrintTicketIr ticket);

        /// <summary>按机型档构建（选卡开关：auto/gprinter 发 FS &amp;、epson42 不发）。
        /// 旧单参调用＝真（兼容存量）。</summary>
        byte[] Build(PrintTicketIr ticket, bool selectChineseCharset);
    }

    /// <summary>ESC/POS 出票引擎实装（小票+标签同构；差异在切纸/走纸参数由调用方给）。</summary>
    public sealed class EscPosTicketEngine : ITicketEngine
    {
        private readonly Encoding _gb18030;
        private readonly EngineLog _log;

        /// <summary>构造（log 可 null＝静默）。</summary>
        /// <param name="log">内核日志抽象（可 null）。</param>
        public EscPosTicketEngine(EngineLog log)
        {
            _log = log ?? EngineLog.Silent;
            _gb18030 = ResolveGb18030();
        }

        /// <summary>方言名（渲染契约 commandSet 值域 esc-pos）。</summary>
        public string CommandSet
        {
            get { return "esc-pos"; }
        }

        /// <inheritdoc />
        public byte[] Build(PrintTicketIr ticket)
        {
            return Build(ticket, true);
        }

        /// <inheritdoc />
        public byte[] Build(PrintTicketIr ticket, bool selectChineseCharset)
        {
            if (ticket == null)
            {
                throw new ArgumentNullException("ticket");
            }

            var frame = new List<byte>(512);
            frame.AddRange(EscPosBuilder.Initialize());
            if (selectChineseCharset)
            {
                // ESC @ 后发 FS &（选择中文字符集卡）；epson42 档不发。
                frame.AddRange(EscPosBuilder.SelectChineseEncoding());
            }

            for (int i = 0; i < ticket.Lines.Count; i++)
            {
                TicketLine line = ticket.Lines[i];
                switch (line.Kind)
                {
                    case TicketLineKind.Text:
                        AppendTextLine(frame, ticket.Columns, line);
                        break;

                    case TicketLineKind.Rule:
                        frame.AddRange(BuildRuleBytes(ticket.Columns, line.Dashed));
                        frame.AddRange(EscPosBuilder.LineFeed());
                        break;

                    case TicketLineKind.Cut:
                        // 8 行 ≈30mm 撕口余量（与后端渲染器同口径；3 行实测撕纸残留）。
                        frame.AddRange(EscPosBuilder.FeedLines(8));
                        frame.AddRange(EscPosBuilder.CutPaper());
                        break;

                    case TicketLineKind.Spacer:
                        frame.AddRange(BuildSpaceDots(line.HeightDots));
                        break;

                    case TicketLineKind.TableRow:
                        AppendTableRow(frame, ticket.Columns, line);
                        break;

                    case TicketLineKind.KeyValue:
                        AppendKeyValue(frame, ticket.Columns, line);
                        break;

                    case TicketLineKind.QrCode:
                        AppendQrCode(frame, line);
                        break;

                    case TicketLineKind.Barcode:
                        AppendBarcode(frame, line);
                        break;

                    default:
                        _log.Warn("print 出票遇到未知 IR 行种类：" + line.Kind + "（跳过）");
                        break;
                }
            }

            // 收尾三态齐备：走纸推出撕纸位（8 行 ≈30mm，3 行实测撕纸残留加厚）
            // →复位字体对齐残余状态→半切。
            frame.AddRange(EscPosBuilder.FeedLines(8));
            return frame.ToArray();
        }

        // ---------- 文本面对 ----------

        /// <summary>
        /// 文本行：对齐前置命令+字号倍率+GB18030 编码正文+LF。
        /// CJK 双宽计列在 PadText 内完成（IR 列数即打印列预算）。
        /// </summary>
        private void AppendTextLine(List<byte> frame, int columns, TicketLine line)
        {
            ApplyAlign(frame, line.Align);
            ApplyFontScale(frame, line.FontScale);

            string padded = PadText(line.Text ?? string.Empty, columns * Math.Max(1, line.FontScale), line.Align);
            byte[] encoded = EncodeCjk(padded);
            if (encoded.Length > 0)
            {
                frame.AddRange(encoded);
            }

            frame.AddRange(EscPosBuilder.LineFeed());
            ApplyFontScale(frame, 1);   // 每行复原，防倍率泄漏到后续行。
        }

        /// <summary>表格行：列宽权重分摊列数，各列内左对齐截断保形。</summary>
        private void AppendTableRow(List<byte> frame, int columns, TicketLine line)
        {
            int columnCount = line.Columns.Count;
            if (columnCount == 0)
            {
                return;
            }

            int totalWeight = 0;
            for (int c = 0; c < columnCount; c++)
            {
                totalWeight += Math.Max(1, line.Columns[c].Value);
            }

            double unit = (double)columns / totalWeight;   // 分母=权重和（非列数）——权重 2:1 于 10 列=7:3 档。
            var rowBuilder = new StringBuilder(columns + 8);
            for (int c = 0; c < columnCount; c++)
            {
                int cellWidth = Math.Max(1, (int)Math.Round(unit * Math.Max(1, line.Columns[c].Value)));
                string cell = line.Columns[c].Key ?? string.Empty;
                rowBuilder.Append(FitCell(cell, cellWidth));
            }

            string padded = PadText(rowBuilder.ToString(), columns, "left");
            byte[] encoded = EncodeCjk(padded);
            if (encoded.Length > 0)
            {
                frame.AddRange(encoded);
            }

            frame.AddRange(EscPosBuilder.LineFeed());
        }

        /// <summary>键值两栏行：键栏占 12 列右对齐值栏左贴。</summary>
        private void AppendKeyValue(List<byte> frame, int columns, TicketLine line)
        {
            int keyWidth = Math.Min(12, columns / 3);
            var rowBuilder = new StringBuilder(columns + 4);
            rowBuilder.Append(FitCell(line.Key ?? string.Empty, keyWidth));
            rowBuilder.Append(FitCell(line.Text ?? string.Empty, columns - keyWidth));
            string padded = rowBuilder.ToString();

            byte[] encoded = EncodeCjk(padded);
            if (encoded.Length > 0)
            {
                frame.AddRange(encoded);
            }

            frame.AddRange(EscPosBuilder.LineFeed());
        }

        // ---------- 码块面 ----------

        /// <summary>
        /// QR 码 GS ( k 四段式（出处=ESC/POS「QR Code」store 命令组，Epson 规范通用子集，
        /// 兼容芯普遍复刻；真机个别芯需 model/ECC 微调=活体窗口核验项）。
        /// 五段帧全带 cn=49(0x31) 字节且 pL 语义=Epson GS ( k QR Code 命令组规范——
        /// 合规机按 cn 解释命令，缺 cn＝命令被忽略＝静默不打 QR。
        /// </summary>
        private static void AppendQrCode(List<byte> frame, TicketLine line)
        {
            ApplyAlign(frame, line.Align);
            byte[] content = Encoding.ASCII.GetBytes(AsciiSafe(line.Text));

            const byte QrCn = 0x31;   // cn=49：QR Code 命令族标识。

            // function 165 model：pL pH=04 00，fn=65('A')，n1=50('2'=model2) n2=00。
            frame.AddRange(new byte[]
            {
                EscPosBuilder.Gs, (byte)'(', (byte)'k', 0x04, 0x00, QrCn,
                (byte)'A', (byte)'2', (byte)'\0'
            });

            // function 167 module size n∈[1,16]：由目标边长 dot 反推模块格（≈边长/content chars 上限 16）。
            byte moduleSize = (byte)Math.Max(1, Math.Min(16, line.HeightDots / Math.Max(1, content.Length)));
            frame.AddRange(new byte[]
            {
                EscPosBuilder.Gs, (byte)'(', (byte)'k', 0x03, 0x00, QrCn,
                (byte)'C', moduleSize
            });

            // function 169 ECC level M（n=0x31）。
            frame.AddRange(new byte[]
            {
                EscPosBuilder.Gs, (byte)'(', (byte)'k', 0x03, 0x00, QrCn,
                (byte)'E', 0x31
            });

            // function 180 store data：pL pH=内容长+3，fn=80('P')，m=0x30('0')。
            int storeLength = content.Length + 3;
            frame.AddRange(new byte[]
            {
                EscPosBuilder.Gs, (byte)'(', (byte)'k', (byte)(storeLength & 0xFF), (byte)((storeLength >> 8) & 0xFF), QrCn,
                (byte)'P', (byte)'0'
            });
            frame.AddRange(content);

            // function 181 print。
            frame.AddRange(new byte[] { EscPosBuilder.Gs, (byte)'(', (byte)'k', 0x03, 0x00, QrCn, (byte)'Q', (byte)'0' });
            ApplyAlign(frame, "left");
        }

        /// <summary>
        /// 条码 GS k m d1..dk（CODE128 subset B 起始符；出处=ESC/POS「BARCODE」命令组）。
        /// 高度 GS h n（dot）前置于条码命令。内容限 ASCII 可见字符集（CODE128B 域）。
        /// </summary>
        private static void AppendBarcode(List<byte> frame, TicketLine line)
        {
            ApplyAlign(frame, line.Align);
            string text = AsciiSafe(line.Text);

            // GS h n：条码高度 dot（n∈[1,255]）。
            frame.AddRange(new[] { EscPosBuilder.Gs, (byte)'h', (byte)Math.Max(1, Math.Min(255, line.HeightDots)) });

            // GS k m CODE128(m=73)：ps=补位 B 子集起始 {B 后接内容。
            frame.Add(EscPosBuilder.Gs);
            frame.Add((byte)'k');
            frame.Add((byte)73);
            byte[] content = Encoding.ASCII.GetBytes("{B" + text);
            frame.Add((byte)Math.Max(1, Math.Min(255, content.Length)));
            frame.AddRange(content);
            frame.AddRange(EscPosBuilder.LineFeed());
            ApplyAlign(frame, "left");
        }

        // ---------- 对齐/字号/分隔线原语 ----------

        /// <summary>ESC a n 三档对齐（0 左/1 中/2 右；EscPosBuilder 无此命令——引擎内自持）。</summary>
        private static void ApplyAlign(List<byte> frame, string align)
        {
            byte mode;
            if (align == "center")
            {
                mode = 1;
            }
            else if (align == "right")
            {
                mode = 2;
            }
            else
            {
                mode = 0;
            }

            frame.AddRange(new[] { EscPosBuilder.Esc, (byte)'a', mode });
        }

        /// <summary>GS ! n 字号倍率（低 4 位宽高倍率-1 即 0=1x 11h=2x；高/宽同倍，
        /// 1-4 档保真——大字号场景；真机倍率细则活体核验项）。</summary>
        private static void ApplyFontScale(List<byte> frame, int scale)
        {
            byte size;
            if (scale >= 4)
            {
                size = 0x33;
            }
            else if (scale == 3)
            {
                size = 0x22;
            }
            else if (scale >= 2)
            {
                size = 0x11;
            }
            else
            {
                size = 0x00;
            }
            frame.AddRange(new[] { EscPosBuilder.Gs, (byte)'!', size });
        }

        /// <summary>分隔线字节（dashes 折半密排——'-' 实线/' '点隔虚线，ASCII 零编码依赖）。</summary>
        private static byte[] BuildRuleBytes(int columns, bool dashed)
        {
            var builder = new StringBuilder(columns);
            for (int i = 0; i < columns; i++)
            {
                builder.Append(!dashed || i % 2 == 0 ? '-' : ' ');
            }

            return Encoding.ASCII.GetBytes(builder.ToString());
        }

        /// <summary>N dot 垂直留白 ≈ dot/30 行 LF（行高 30 dot＝主流 203dpi 热敏 1/6 英寸＝4.23mm；
        /// 原 24 dot 口径系统性偏高 25%——评审实核修正）。</summary>
        private static IEnumerable<byte> BuildSpaceDots(int heightDots)
        {
            int lines = Math.Max(1, heightDots / 30);
            var bytes = new List<byte>(lines);
            for (int i = 0; i < lines; i++)
            {
                bytes.AddRange(EscPosBuilder.LineFeed());
            }

            return bytes;
        }

        // ---------- 排版工具 ----------

        /// <summary>列预算对齐填充：CJK 双宽折算（显示宽度≠UTF-16 char 数；EncodeCjk 前 ASCII 填充安全）。</summary>
        internal static string PadText(string text, int columns, string align)
        {
            if (columns <= 0)
            {
                return text ?? string.Empty;
            }

            int width = DisplayWidth(text);
            if (width >= columns)
            {
                return TruncateToWidth(text, columns);
            }

            int padCount = columns - width;
            if (align == "center")
            {
                int left = padCount / 2;
                return new string(' ', left) + text + new string(' ', padCount - left);
            }

            if (align == "right")
            {
                return new string(' ', padCount) + text;
            }

            return text + new string(' ', padCount);
        }

        /// <summary>单元格 fit：超宽截断+尾空格补齐。</summary>
        private static string FitCell(string cell, int cellWidth)
        {
            string fitted = DisplayWidth(cell) > cellWidth ? TruncateToWidth(cell, cellWidth) : cell;
            int fill = cellWidth - DisplayWidth(fitted);
            return fill > 0 ? fitted + new string(' ', fill) : fitted;
        }

        /// <summary>显示宽度：CJK/全角区双宽（BMP 判别 U+1100 起 CJK 块段+FF00 全角形态区），其余单宽。</summary>
        internal static int DisplayWidth(string text)
        {
            if (string.IsNullOrEmpty(text))
            {
                return 0;
            }

            int width = 0;
            for (int i = 0; i < text.Length; i++)
            {
                width += IsWideChar(text[i]) ? 2 : 1;
            }

            return width;
        }

        /// <summary>按显示宽度截断（双宽字符不可劈半——放不下时舍弃）。</summary>
        internal static string TruncateToWidth(string text, int maxWidth)
        {
            var builder = new StringBuilder(text.Length);
            int width = 0;
            for (int i = 0; i < text.Length; i++)
            {
                int charWidth = IsWideChar(text[i]) ? 2 : 1;
                if (width + charWidth > maxWidth)
                {
                    break;
                }

                builder.Append(text[i]);
                width += charWidth;
            }

            return builder.ToString();
        }

        /// <summary>CJK/全角判别（块段扫描器——证据基线 GB18030 双宽集合工程近似：
        /// U+2E80-U+A4CF/AC00-D7A3/F900-FAFF/FF00-FF60/FFE0-FFE6）。</summary>
        private static bool IsWideChar(char c)
        {
            return (c >= 0x2E80 && c <= 0xA4CF) ||
                   (c >= 0xAC00 && c <= 0xD7A3) ||
                   (c >= 0xF900 && c <= 0xFAFF) ||
                   (c >= 0xFF00 && c <= 0xFF60) ||
                   (c >= 0xFFE0 && c <= 0xFFE6);
        }

        /// <summary>码块内容 ASCII 清洗（非可见 ASCII 降 '?'——码制容错在可扫性冗余内）。</summary>
        private static string AsciiSafe(string text)
        {
            if (string.IsNullOrEmpty(text))
            {
                return string.Empty;
            }

            var builder = new StringBuilder(text.Length);
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                builder.Append(c >= 0x20 && c <= 0x7E ? c : '?');
            }

            return builder.ToString();
        }

        /// <summary>中文编码 GB18030 注册+获取单点（CodePages 提供程序进程级幂等注册）。</summary>
        private static Encoding ResolveGb18030()
        {
            try
            {
                Encoding.RegisterProvider(System.Text.CodePagesEncodingProvider.Instance);
                return Encoding.GetEncoding("GB18030");
            }
            catch (Exception ex)
            {
                throw new PrintDomainException(
                    PrintErrorCode.EncodingUnavailable,
                    "GB18030 编码不可用（System.Text.Encoding.CodePages 提供程序注册失败）——出票引擎无法落中文票面", ex);
            }
        }

        private byte[] EncodeCjk(string text)
        {
            return _gb18030.GetBytes(text ?? string.Empty);
        }
    }

    /// <summary>驱动路（Spooler GDI Raw）出票通道：IR 经 EscPosTicketEngine 编帧直写 RAW 队列
    /// （票据打印业界主流路径：RAW passthrough 免 GDI 光栅化，保留打印机原生命令处理）。
    /// 缝位形态与 SpoolerRawPrinterChannel.WriteRawAsync 直连复用。</summary>
    public sealed class SpoolerTicketChannel
    {
        private readonly IPrinterChannel _channel;
        private readonly ITicketEngine _engine;

        /// <summary>构造（通道与引擎双必填）。</summary>
        /// <param name="channel">打印机通道（裸字节送打）。</param>
        /// <param name="engine">出票引擎（IR→方言字节）。</param>
        public SpoolerTicketChannel(IPrinterChannel channel, ITicketEngine engine)
        {
            if (channel == null)
            {
                throw new ArgumentNullException("channel");
            }

            if (engine == null)
            {
                throw new ArgumentNullException("engine");
            }

            _channel = channel;
            _engine = engine;
        }

        /// <summary>一次完整出票：EnsureOpen→Build→WriteRawAsync（通道异常类型化直通调用方）。</summary>
        public System.Threading.Tasks.Task PrintAsync(PrintTicketIr ticket, CancellationToken cancellationToken)
        {
            _channel.EnsureOpen();
            byte[] payload = _engine.Build(ticket);
            return _channel.WriteRawAsync(payload, cancellationToken);
        }
    }
}
