// SPDX-License-Identifier: Apache-2.0
#nullable disable
using System;
using System.Collections.Generic;
using System.Text;

namespace Taprint.PrintDsl.Engine
{
    /// <summary>
    /// IR → 票面位图像素（纯函数面：零 UI 框架/零 IO，输出 1bpp 索引像素+尺寸，
    /// 位图编码归宿主 App 层）。
    ///
    /// <para>为什么存在：模板编辑器实时预览需要「改一处立即见票面」——走真实打印字节流再
    /// 反解位图等于再造一套 ESC/POS parser（脆弱且双渲染面漂移），故从
    /// <see cref="PrintTicketIr"/> 直接绘制：行高按 FontScale 倍数、表格列按宽度权重、
    /// 对齐三态，与出票引擎（字节流）/后端渲染器（PNG）三方同口径。</para>
    ///
    /// <para>像素语义：byte 0=墨（黑）、1=纸（白）——与热敏打印一致；WidthBytes=每行字节
    /// （8 像素/字节，尾字节补齐）。</para>
    /// </summary>
    public static class IrPreviewRenderer
    {
        /// <summary>基础行高 dot（24 dot/行——渲染交接口径）。</summary>
        public const int BaseLineDots = 24;

        /// <summary>基础字符宽 dot（12 dot——CJK 双宽=24 与 48 列纸宽对齐）。</summary>
        public const int BaseCharDots = 12;

        /// <summary>渲染结果：Pixels[y*Stride+x]=0 墨/1 纸；Stride=WidthBytes*8。</summary>
        public sealed class PreviewBitmap
        {
            /// <summary>位图宽（像素）。</summary>
            public int Width { get; }

            /// <summary>位图高（像素）。</summary>
            public int Height { get; }

            /// <summary>每行字节数（8 像素/字节）。</summary>
            public int WidthBytes { get; }

            /// <summary>1bpp 索引像素（0=墨/1=纸）。</summary>
            public byte[] Pixels { get; }

            /// <summary>构造。</summary>
            /// <param name="width">位图宽。</param>
            /// <param name="height">位图高。</param>
            /// <param name="widthBytes">每行字节数。</param>
            /// <param name="pixels">1bpp 索引像素缓冲。</param>
            public PreviewBitmap(int width, int height, int widthBytes, byte[] pixels)
            {
                Width = width;
                Height = height;
                WidthBytes = widthBytes;
                Pixels = pixels;
            }

            /// <summary>位图行距（每行像素数＝WidthBytes*8——像素逐 byte 铺；
            /// 壳层曾误传 WidthBytes 当灰度 stride=预览空白根因之一，禁重犯）。</summary>
            public int Stride
            {
                get { return WidthBytes * 8; }
            }

            /// <summary>
            /// 灰度像表面（宿主 Gray8 位图直用形态）：0=墨→0（黑）、非0=纸→255（白），
            /// 行距=Stride——1/255 在 Gray8 里近似纯黑，直喂 Pixels 会整图发黑
            /// （预览空白根因之二）。
            /// </summary>
            public Gray8Surface ToGray8()
            {
                int stride = Stride;
                byte[] gray = new byte[stride * Height];
                for (int y = 0; y < Height; y++)
                {
                    int srcBase = y * stride;
                    for (int x = 0; x < stride; x++)
                    {
                        gray[srcBase + x] = Pixels[srcBase + x] == 0 ? (byte)0 : (byte)255;
                    }
                }

                return new Gray8Surface(gray, stride);
            }
        }

        /// <summary>Gray8 像表面（pixels+stride——宿主位图创建直用形态）。</summary>
        public sealed class Gray8Surface
        {
            /// <summary>构造。</summary>
            /// <param name="pixels">灰度像素（0=黑/255=白，行距 stride）。</param>
            /// <param name="stride">行距（字节）。</param>
            public Gray8Surface(byte[] pixels, int stride)
            {
                Pixels = pixels;
                Stride = stride;
            }

            /// <summary>灰度像素（0=黑/255=白，行距 Stride）。</summary>
            public byte[] Pixels { get; }

            /// <summary>行距（字节）。</summary>
            public int Stride { get; }
        }

        /// <summary>Ir → 位图像素（纯函数）。</summary>
        public static PreviewBitmap Render(PrintTicketIr ir)
        {
            if (ir == null)
            {
                throw new ArgumentNullException("ir");
            }

            int widthDots = ir.Columns * BaseCharDots;
            int widthBytes = (widthDots + 7) / 8;
            int width = widthBytes * 8;

            // 逐行物化成段（行高随 FontScale），最后整体拷入位图。
            var rows = new List<Row>();
            foreach (TicketLine line in ir.Lines)
            {
                AppendLine(rows, line, widthDots, widthBytes);
            }

            int heightDots = 0;
            foreach (Row rowItem in rows)
            {
                heightDots += rowItem.HeightDots;
            }

            int height = Math.Max(heightDots, BaseLineDots);
            byte[] pixels = new byte[widthBytes * 8 * height];
            for (int i = 0; i < pixels.Length; i++)
            {
                pixels[i] = 1;   // 纸底
            }

            var bitmap = new PreviewBitmap(width, height, widthBytes, pixels);
            int y = 0;
            foreach (Row row in rows)
            {
                row.Paint(pixels, widthBytes, y);
                y += row.HeightDots;
            }

            return bitmap;
        }

        private sealed class Row
        {
            public int HeightDots;
            public int RowDots;
            public readonly List<Span> Spans = new List<Span>();

            public void Paint(byte[] pixels, int widthBytes, int topDots)
            {
                foreach (Span span in Spans)
                {
                    if (span.IsRule)
                    {
                        int midDots = topDots + (BaseLineDots / 2);
                        int step = span.Dashed ? 4 : 2;
                        for (int x = span.X; x < span.X + span.WidthDots; x += step)
                        {
                            SetDot(pixels, widthBytes, midDots, x, 2);
                        }

                        return;
                    }
                }

                foreach (Span span in Spans)
                {
                    if (string.IsNullOrEmpty(span.Text))
                    {
                        continue;
                    }

                    int scale = Math.Max(1, span.WidthDots / Math.Max(1, DisplayWidth(span.Text) * BaseCharDots));
                    int charDots = BaseCharDots * scale;
                    int glyphDots = BaseLineDots * scale;
                    int y0 = topDots + Math.Max(0, (RowDots - glyphDots) / 2);
                    int cx = span.X;
                    foreach (char ch in span.Text)
                    {
                        int cw = (ch > 0xFF ? 2 : 1) * charDots;
                        FillRect(pixels, widthBytes, cx + 1, y0 + 2, Math.Max(2, cw - 2), Math.Max(4, glyphDots - 4));
                        cx += cw;
                    }
                }
            }

            private static void FillRect(byte[] pixels, int widthBytes, int x, int y, int w, int h)
            {
                for (int dy = 0; dy < h; dy++)
                {
                    for (int dx = 0; dx < w; dx++)
                    {
                        SetDot(pixels, widthBytes, y + dy, x + dx, 2);
                    }
                }
            }
        }

        private sealed class Span
        {
            public int X;
            public int WidthDots;
            public string Text;
            public bool IsRule;
            public bool Dashed;
        }

        private static void AppendLine(List<Row> rows, TicketLine line, int widthDots, int widthBytes)
        {
            switch (line.Kind)
            {
                case TicketLineKind.Rule:
                    rows.Add(RuleRow(line.Dashed, widthDots, widthBytes));
                    return;
                case TicketLineKind.Cut:
                    rows.Add(RuleRow(false, widthDots, widthBytes));
                    return;
                case TicketLineKind.Spacer:
                    int spacerDots = Math.Max(1, line.HeightDots);
                    rows.Add(BlankRow(spacerDots));
                    return;
                default:
                    break;
            }

            int scale = Math.Max(1, Math.Min(4, line.FontScale));
            int rowDots = BaseLineDots * scale;

            switch (line.Kind)
            {
                case TicketLineKind.TableRow:
                case TicketLineKind.KeyValue:
                    rows.Add(ColumnsRow(line, widthDots, widthBytes, scale));
                    return;
                case TicketLineKind.QrCode:
                case TicketLineKind.Barcode:
                    rows.Add(CenteredBlockRow(line.Text, widthDots, widthBytes, rowDots, line.HeightDots));
                    return;
                default:
                    rows.Add(TextRow(line.Text ?? string.Empty, line.Align, scale, widthDots, widthBytes, rowDots));
                    return;
            }
        }

        private static Row TextRow(string text, string align, int scale, int widthDots, int widthBytes, int rowDots)
        {
            var row = new Row { HeightDots = rowDots, RowDots = rowDots };
            int charDots = BaseCharDots * scale;
            int textDots = DisplayWidth(text) * BaseCharDots * scale;
            int x = AlignX(align, textDots, widthDots);
            if (x + textDots > widthDots)
            {
                textDots = Math.Max(0, widthDots - x);   // 超宽截断（与热敏打印截断一致）
            }

            row.Spans.Add(new Span { X = x, WidthDots = textDots, Text = text });
            return row;
        }

        private static Row ColumnsRow(TicketLine line, int widthDots, int widthBytes, int scale)
        {
            int rowDots = BaseLineDots * Math.Max(1, Math.Min(4, scale));
            var row = new Row { HeightDots = rowDots, RowDots = rowDots };
            int totalWeight = 0;
            for (int i = 0; i < line.Columns.Count; i++)
            {
                totalWeight += Math.Max(1, line.Columns[i].Value);
            }

            if (totalWeight <= 0)
            {
                return row;
            }

            int x = 0;
            for (int i = 0; i < line.Columns.Count; i++)
            {
                int weight = Math.Max(1, line.Columns[i].Value);
                int cellDots = widthDots * weight / totalWeight;
                string cell = i < line.Columns.Count - 1
                    ? TruncateToWidth(line.Columns[i].Key, cellDots, scale)
                    : line.Columns[i].Key;   // 末列不截断（金额右对齐天然贴右）
                int textDots = DisplayWidth(cell) * BaseCharDots * scale;
                int cellX = i == line.Columns.Count - 1
                    ? Math.Max(0, x + cellDots - textDots)   // 末列右对齐（金额惯例）
                    : x;
                row.Spans.Add(new Span { X = cellX, WidthDots = textDots, Text = cell });
                x += cellDots;
            }

            return row;
        }

        private static Row RuleRow(bool dashed, int widthDots, int widthBytes)
        {
            var row = new Row { HeightDots = BaseLineDots };
            var span = new Span { X = 0, WidthDots = widthDots, IsRule = true, Dashed = dashed };
            row.Spans.Add(span);
            // Rule 行用整行画横线的专用 Paint 语义：借 Text 槽位标记。
            span.Text = null;
            return row;
        }

        private static Row BlankRow(int dots)
        {
            return new Row { HeightDots = Math.Max(1, dots) };
        }

        private static Row CenteredBlockRow(string text, int widthDots, int widthBytes, int rowDots, int blockDots)
        {
            var row = new Row { HeightDots = Math.Max(rowDots, Math.Max(1, blockDots)) };
            int blockWidth = Math.Min(widthDots, 8 * BaseCharDots * 4);   // QR 近似方块
            int x = Math.Max(0, (widthDots - blockWidth) / 2);
            row.Spans.Add(new Span { X = x, WidthDots = blockWidth, Text = "▣" });
            return row;
        }

        private static int AlignX(string align, int contentDots, int widthDots)
        {
            if (string.Equals(align, "center", StringComparison.OrdinalIgnoreCase))
            {
                return Math.Max(0, (widthDots - contentDots) / 2);
            }

            if (string.Equals(align, "right", StringComparison.OrdinalIgnoreCase))
            {
                return Math.Max(0, widthDots - contentDots);
            }

            return 0;
        }

        private static int DisplayWidth(string text)
        {
            int width = 0;
            foreach (char ch in text ?? string.Empty)
            {
                width += ch > 0xFF ? 2 : 1;   // CJK 双宽
            }

            return width;
        }

        private static void SetDot(byte[] pixels, int widthBytes, int y, int x, int thickness)
        {
            for (int t = 0; t < thickness; t++)
            {
                int px = x + t;
                int idx = (y * widthBytes * 8) + px;
                if (idx >= 0 && idx < pixels.Length)
                {
                    pixels[idx] = 0;
                }
            }
        }

        private static string TruncateToWidth(string text, int maxDots, int scale)
        {
            int acc = 0;
            var builder = new StringBuilder();
            foreach (char ch in text ?? string.Empty)
            {
                int w = ch > 0xFF ? 2 : 1;
                if (acc + w > maxDots)
                {
                    break;
                }

                builder.Append(ch);
                acc += w;
            }

            return builder.ToString();
        }
    }
}
