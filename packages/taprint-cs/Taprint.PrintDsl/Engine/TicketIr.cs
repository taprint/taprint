// SPDX-License-Identifier: Apache-2.0
#nullable disable
using System;
using System.Collections.Generic;

namespace Taprint.PrintDsl.Engine
{
    // ============================================================
    // 设备无关中间表示（IR 面）。
    //
    // TicketIrBuilder：DslDocument + 业务数据 → PrintTicketIr 行序列。
    // 布局决策（同构上游 Dart 票据仿真器，差异=PC 全量行渲染）：
    //   - 列数：80mm→48 / 58mm→32；
    //   - text 双宽 CJK 计列、对齐三档；line 虚/实；cut=切纸行；
    //   - table 逐数据源行展开列文本（全量，非仿真器一轮）；
    //   - kvtable 键值对行；qrcode/barcode 承载内容与尺寸（ESC/POS 码制命令面）；
    //   - loop 遍历 data[source] 全行（每行一帧作用域）；conditional 真走 body
    //     假走 elseBody；未知元素跳过（cashDrawer 由引擎在送打前附挂钱箱脉冲）。
    // ============================================================

    /// <summary>IR 行种类。</summary>
    public enum TicketLineKind
    {
        /// <summary>文本行（可对齐；双宽 CJK 计列已折算）。</summary>
        Text = 1,

        /// <summary>分隔线（虚线=点线样式）。</summary>
        Rule = 2,

        /// <summary>切纸位标记。</summary>
        Cut = 3,

        /// <summary>留白行。</summary>
        Spacer = 4,

        /// <summary>表格展开后的表格行（各列文本+宽度权重）。</summary>
        TableRow = 5,

        /// <summary>键值对行（kvtable 展开形态复用双栏布局）。</summary>
        KeyValue = 6,

        /// <summary>二维码块（content 定位用文本+模块尺寸）。</summary>
        QrCode = 7,

        /// <summary>条码块（content+高度 dot）。</summary>
        Barcode = 8,
    }

    /// <summary>IR 单行。字段集随 Kind 取用，禁越类读（Text 三件套/TableRow 列集等）。</summary>
    public sealed class TicketLine
    {
        /// <summary>行种类判别。</summary>
        public TicketLineKind Kind { get; set; }

        /// <summary>Text/KeyValue/QrCode/Barcode 的主文本（表达式已替换）。</summary>
        public string Text { get; set; }

        /// <summary>KeyValue 的键侧文本。</summary>
        public string Key { get; set; }

        /// <summary>left|center|right（Rule/Cut 恒 left 无语义）。</summary>
        public string Align { get; set; }

        /// <summary>字号倍率（double 样式 2 倍——仿真器 fontSize 口径）。</summary>
        public int FontScale { get; set; }

        /// <summary>Spacer 高度 dot；QrCode 模块边长 dot；Barcode 条高 dot。</summary>
        public int HeightDots { get; set; }

        /// <summary>Rule 是否虚线。</summary>
        public bool Dashed { get; set; }

        /// <summary>TableRow 列（文本, 宽度权重）序偶。</summary>
        public IList<KeyValuePair<string, int>> Columns { get; private set; }

        /// <summary>构造（种类判别+缺省面）。</summary>
        /// <param name="kind">行种类。</param>
        public TicketLine(TicketLineKind kind)
        {
            Kind = kind;
            Text = string.Empty;
            Key = string.Empty;
            Align = "left";
            FontScale = 1;
            Columns = new List<KeyValuePair<string, int>>();
        }
    }

    /// <summary>出票中间表示：一个呈现分区一次展开的行序列+纸参数。</summary>
    public sealed class PrintTicketIr
    {
        /// <summary>纸宽毫米（引擎换算列数）。</summary>
        public double PaperWidthMm { get; set; }

        /// <summary>列数（80→48 / 58→32 引擎换算口径）。</summary>
        public int Columns { get; set; }

        /// <summary>顺序化行。</summary>
        public IList<TicketLine> Lines { get; private set; }

        /// <summary>构造（80mm/48 列缺省）。</summary>
        public PrintTicketIr()
        {
            PaperWidthMm = 80d;
            Columns = 48;
            Lines = new List<TicketLine>();
        }
    }

    /// <summary>DslDocument+data → PrintTicketIr 构建器（纯函数面零 IO 单测直覆）。</summary>
    public static class TicketIrBuilder
    {
        /// <summary>80mm 缺省列数。</summary>
        private const int ColumnsWide = 48;

        /// <summary>58mm 档列数。</summary>
        private const int ColumnsNarrow = 32;

        /// <summary>缺省行高倍（spacer 兜底 3mm×8dot——仿真器兜底同款）。</summary>
        private const int DefaultSpacerDots = 24;

        /// <summary>二维码模块边长缺省 dot（仿真器 size=6mm×8 兜底同款）。</summary>
        private const int DefaultQrSideDots = 48;

        /// <summary>
        /// qrcode size 契约收口：size 口径恒=毫米——数值/纯数字串按 mm 折算一次；
        /// "Nmm" 显式形态同为毫米，DslDimension.ParseDots 已完成 mm→dot 折算，禁二次乘
        /// （修前路径对 "6mm" 先折 48dot 再乘 8 = 384dot 巨码）。设计器恒发数值 mm，
        /// DSL 手写面两形等价收敛为同一 dot 值。
        /// </summary>
        private static int ParseQrSideDots(object rawSize)
        {
            string text = rawSize as string;
            if (text != null && text.Trim().EndsWith("mm", StringComparison.OrdinalIgnoreCase))
            {
                return DslDimension.ParseDots(rawSize, DefaultQrSideDots);
            }

            return DslDimension.ParseDots(rawSize, 6) * DslDimension.DotsPerMm;
        }

        /// <summary>条码高度缺省 dot（仿真器 height=5mm×8 兜底同款）。</summary>
        private const int DefaultBarcodeHeightDots = 40;

        /// <summary>
        /// 出票构建主入口：指定呈现名（receipt/label）取分区展开全量行。
        /// 无该呈现时空 IR（调用方按 bizType 保证存在性）。
        /// </summary>
        public static PrintTicketIr Build(DslDocument document, string presentation, IDictionary<string, object> data)
        {
            if (document == null)
            {
                throw new ArgumentNullException("document");
            }

            var ir = new PrintTicketIr();
            ir.PaperWidthMm = document.PaperWidthMm;
            ir.Columns = document.PaperWidthMm <= 58d ? ColumnsNarrow : ColumnsWide;

            ExpressionScope scope = new ExpressionScope();
            scope.Push(data ?? new Dictionary<string, object>());   // 根帧：根级路径（store.name/order.no 等）求值基座；loop 行帧在其上按内层优先叠加。
            for (int i = 0; i < document.Sections.Count; i++)
            {
                DslSection section = document.Sections[i];
                if (!string.Equals(section.Presentation, presentation, StringComparison.Ordinal))
                {
                    continue;
                }

                ExpandElements(ir.Lines, section.Elements, scope, data);
            }

            return ir;
        }

        /// <summary>元素树递归展开（容器下钻+叶子装配）。</summary>
        private static void ExpandElements(IList<TicketLine> lines, IList<DslElement> elements, ExpressionScope scope, IDictionary<string, object> rootData)
        {
            for (int i = 0; i < elements.Count; i++)
            {
                DslElement element = elements[i];
                switch (element.Type)
                {
                    case "text":
                        AddText(lines, element, DslExpression.Substitute(element.Text("content"), scope), element.Text("content"));
                        break;

                    case "line":
                        var rule = new TicketLine(TicketLineKind.Rule);
                        rule.Dashed = element.Text("lineStyle") == "dashed";
                        rule.Align = "left";
                        lines.Add(rule);
                        break;

                    case "cut":
                        lines.Add(new TicketLine(TicketLineKind.Cut));
                        break;

                    case "spacer":
                        var spacer = new TicketLine(TicketLineKind.Spacer);
                        spacer.HeightDots = DslDimension.ParseDots(element.Get("height"), DefaultSpacerDots);
                        spacer.Align = "left";
                        lines.Add(spacer);
                        break;

                    case "table":
                        ExpandTable(lines, element, scope);
                        break;

                    case "kvtable":
                        ExpandKvTable(lines, element, scope);
                        break;

                    case "image":
                        // 位图图元 ESC/POS 光栅命令属驱动路增强位：本期以占位行承载
                        // （LOGO 静态资料未核验登记，标签路不做位图降级）。
                        var image = new TicketLine(TicketLineKind.Spacer);
                        image.HeightDots = DslDimension.ParseDots(element.Get("height"), DefaultSpacerDots);
                        image.Align = "left";
                        lines.Add(image);
                        break;

                    case "qrcode":
                        var qr = new TicketLine(TicketLineKind.QrCode);
                        qr.Text = DslExpression.Substitute(element.Text("content"), scope);
                        qr.HeightDots = ParseQrSideDots(element.Get("size"));
                        if (qr.HeightDots <= 0)
                        {
                            qr.HeightDots = DefaultQrSideDots;
                        }

                        qr.Align = element.AlignOrLeft();
                        lines.Add(qr);
                        break;

                    case "barcode":
                        var barcode = new TicketLine(TicketLineKind.Barcode);
                        barcode.Text = DslExpression.Substitute(element.Text("content"), scope);
                        barcode.HeightDots = DslDimension.ParseDots(element.Get("height"), DefaultBarcodeHeightDots);
                        barcode.Align = element.AlignOrLeft();
                        lines.Add(barcode);
                        break;

                    case "loop":
                        ExpandLoop(lines, element, scope, rootData);
                        break;

                    case "conditional":
                        // 正典键 when→旧方言 condition 回退（both-keys 正典胜出）。
                        if (DslExpression.EvaluateTruthy(CanonicalText(element, "when", "condition"), scope))
                        {
                            ExpandElements(lines, element.Body, scope, rootData);
                        }
                        else
                        {
                            ExpandElements(lines, element.ElseBody, scope, rootData);
                        }

                        break;

                    default:
                        // cashDrawer 等指令元素不进票面布局（仿真器同款跳过）。
                        break;
                }
            }
        }

        /// <summary>text 行装配（表达式替换后字体样式解析）。</summary>
        private static void AddText(IList<TicketLine> lines, DslElement element, string resolved, string rawContent)
        {
            var line = new TicketLine(TicketLineKind.Text);

            // 未闭合/缺数据的表达式残留原样进票面会误导使用者——统一空白化
            //（Substitute 只负责 "{{path}}→空"，这里把纯表达式元素清成空行）。
            line.Text = resolved ?? string.Empty;
            line.Align = element.AlignOrLeft();
            line.FontScale = ParseFontScale(element.Get("fontSize"));

            // 引用式静态判定与上游 _isStaticText 一致：内容含 {{ 即动态。
            bool isDynamic = !string.IsNullOrEmpty(rawContent) && rawContent.Contains("{{");
            if (!isDynamic || line.Text.Length > 0)
            {
                lines.Add(line);
            }
            else
            {
                // 动态元素求值为空仍占一行结构位（表头对齐不塌陷），只清字面量。
                line.Text = string.Empty;
                lines.Add(line);
            }
        }

        /// <summary>loop 展开：data[source] 列表逐行压帧渲染 body（空源退化为无帧单轮——
        /// 标签主数据常为标量的兼容面）。</summary>
        private static void ExpandLoop(IList<TicketLine> lines, DslElement element, ExpressionScope scope, IDictionary<string, object> rootData)
        {
            // 正典键 each→旧方言 source 回退（both-keys 正典胜出——列表 each:"goodsList" 主战场）。
            string source = CanonicalText(element, "each", "source");
            object rows = null;
            if (!string.IsNullOrEmpty(source))
            {
                rows = DslExpression.Lookup(rootData, source);
            }

            var rowList = rows as IList<object>;
            if (rowList == null)
            {
                ExpandElements(lines, element.Body, scope, rootData);   // 标量作用域兜底。
                return;
            }

            for (int r = 0; r < rowList.Count; r++)
            {
                var frame = rowList[r] as IDictionary<string, object>;
                if (frame == null)
                {
                    continue;
                }

                scope.Push(frame);
                try
                {
                    ExpandElements(lines, element.Body, scope, rootData);
                }
                finally
                {
                    scope.Pop();
                }
            }
        }

        /// <summary>table 展开：columns 定形状，data[source] 逐行产出 TableRow（全量非一轮）。</summary>
        private static void ExpandTable(IList<TicketLine> lines, DslElement element, ExpressionScope scope)
        {
            IList<object> columnsSpec = element.Get("columns") as IList<object>;
            if (columnsSpec == null || columnsSpec.Count == 0)
            {
                return;
            }

            var headers = new List<KeyValuePair<string, int>>();
            var contentFields = new List<string>();
            for (int c = 0; c < columnsSpec.Count; c++)
            {
                var columnSpec = columnsSpec[c] as IDictionary<string, object>;
                if (columnSpec == null)
                {
                    continue;
                }

                string field = GetText(columnSpec, "field");
                // 正典列头 header→旧方言 label 回退；宽度正典=百分比串（"52%"→权重 52），
                // 旧方言=数字权重——两种形态都进权重语义（值级钉防「解析失败回落 1」假绿）。
                string label = GetText(columnSpec, "header") ?? GetText(columnSpec, "label");
                int width = ParseColumnWeight(columnSpec);
                headers.Add(new KeyValuePair<string, int>(label ?? string.Empty, width));
                contentFields.Add(field ?? string.Empty);
            }

            // 表头行（bold 断言由引擎按首行加粗处理——样张可见性优先）。
            var headerLine = new TicketLine(TicketLineKind.TableRow);
            for (int h = 0; h < headers.Count; h++)
            {
                headerLine.Columns.Add(headers[h]);
            }

            headerLine.FontScale = 1;
            lines.Add(headerLine);

            string source = element.Text("source");
            object rows = null;
            if (!string.IsNullOrEmpty(source))
            {
                rows = scope.LookupObject(source);
            }

            var rowList = rows as IList<object>;
            if (rowList == null)
            {
                return;
            }

            for (int r = 0; r < rowList.Count; r++)
            {
                var rowData = rowList[r] as IDictionary<string, object>;
                if (rowData == null)
                {
                    continue;
                }

                var row = new TicketLine(TicketLineKind.TableRow);
                scope.Push(rowData);
                try
                {
                    for (int f = 0; f < contentFields.Count; f++)
                    {
                        object cellValue = rowData.ContainsKey(contentFields[f])
                            ? rowData[contentFields[f]]
                            : scope.LookupObject(contentFields[f]);
                        row.Columns.Add(new KeyValuePair<string, int>(
                            DslValues.AsText(cellValue), headers[f].Value));
                    }
                }
                finally
                {
                    scope.Pop();
                }

                lines.Add(row);
            }
        }

        /// <summary>
        /// kvtable 展开（双形态）：正典 rows=三层嵌套字面量对
        /// [[[键,值表达式],…],…]（外层=行、中层=键值对、内层=[键文本, 值表达式]——值表达式
        /// 含 {{x | currency:CNY}} 走管道腿）→旧方言 keys:[{label,key}] 回退。
        /// 正典多对行逐对平铺成独立 KeyValue 行（生产种子皆单对行）。
        /// </summary>
        private static void ExpandKvTable(IList<TicketLine> lines, DslElement element, ExpressionScope scope)
        {
            IList<object> canonicalRows = element.Get("rows") as IList<object>;
            if (canonicalRows != null)
            {
                for (int r = 0; r < canonicalRows.Count; r++)
                {
                    var pairs = canonicalRows[r] as IList<object>;
                    if (pairs == null)
                    {
                        continue;
                    }

                    for (int p = 0; p < pairs.Count; p++)
                    {
                        var pair = pairs[p] as IList<object>;
                        if (pair == null || pair.Count < 2)
                        {
                            continue;
                        }

                        string keyText = AsStringOrNull(pair[0]);
                        string valueExpr = AsStringOrNull(pair[1]);
                        if (keyText == null && valueExpr == null)
                        {
                            continue;
                        }

                        var line = new TicketLine(TicketLineKind.KeyValue);
                        line.Key = keyText ?? string.Empty;
                        line.Text = ResolveKvValue(valueExpr, scope);
                        line.Align = "left";
                        lines.Add(line);
                    }
                }

                return;
            }

            IList<object> keys = element.Get("keys") as IList<object>;
            if (keys == null)
            {
                return;
            }

            for (int k = 0; k < keys.Count; k++)
            {
                var keySpec = keys[k] as IDictionary<string, object>;
                if (keySpec == null)
                {
                    continue;
                }

                // 容错取键：缺 label 的 keys 条目直下标会抛 KeyNotFound 炸渲染链——
                // 逐键 TryGetValue。
                object labelRaw;
                object pathRaw;
                string label = keySpec.TryGetValue("label", out labelRaw) ? AsStringOrNull(labelRaw) : null;
                string path = keySpec.TryGetValue("key", out pathRaw) ? AsStringOrNull(pathRaw) : null;
                if (string.IsNullOrEmpty(path))
                {
                    continue;
                }

                var line = new TicketLine(TicketLineKind.KeyValue);
                line.Key = label ?? path;
                line.Text = scope.Resolve(path);
                line.Align = "left";
                lines.Add(line);
            }
        }

        /// <summary>kvtable 正典值元素求值：全表达式（{{…}} 含滤器）走 Substitute；裸路径走 Resolve。</summary>
        private static string ResolveKvValue(string valueExpr, ExpressionScope scope)
        {
            string trimmed = (valueExpr ?? string.Empty).Trim();
            if (trimmed.Length == 0)
            {
                return string.Empty;
            }

            if (trimmed.StartsWith("{{", StringComparison.Ordinal))
            {
                return DslExpression.Substitute(trimmed, scope);
            }

            return scope.Resolve(trimmed);
        }

        /// <summary>正典键优先取文（both-keys 并写正典胜出）；两键皆缺=空。</summary>
        private static string CanonicalText(DslElement element, string canonicalKey, string legacyKey)
        {
            string value = element.Text(canonicalKey);
            if (string.IsNullOrEmpty(value))
            {
                value = element.Text(legacyKey);
            }

            return value;
        }

        /// <summary>字典安全取文（缺键=null——正典模板无旧方言键，禁直下标抛 KeyNotFound）。</summary>
        private static string GetText(IDictionary<string, object> map, string key)
        {
            object value;
            return map.TryGetValue(key, out value) ? AsStringOrNull(value) : null;
        }

        /// <summary>列宽权重：正典百分比串（"52%"→52）/数字（旧权重）→最小 1。</summary>
        private static int ParseColumnWeight(IDictionary<string, object> columnSpec)
        {
            object raw;
            if (!columnSpec.TryGetValue("width", out raw) || raw == null)
            {
                return 1;
            }

            string text = raw as string;
            if (text != null && text.TrimEnd().EndsWith("%", StringComparison.Ordinal))
            {
                double percent;
                if (double.TryParse(text.Substring(0, text.Length - 1), System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out percent) && percent > 0d)
                {
                    return (int)Math.Round(percent);
                }

                return 1;
            }

            double number = DslValues.AsNumber(raw, 1d);
            return number > 0d ? (int)Math.Round(number) : 1;
        }

        /// <summary>fontScale 解析（number 2=两倍宽高；非法回落 1）。
        /// 1-4 档保真（大字号场景），与渲染端 EscPosRenderer 同口径（禁两处漂移）。</summary>
        private static int ParseFontScale(object raw)
        {
            double scale = DslValues.AsNumber(raw, 1d);
            if (scale >= 4d)
            {
                return 4;
            }
            if (scale >= 3d)
            {
                return 3;
            }
            if (scale >= 2d)
            {
                return 2;
            }

            return 1;
        }

        private static string AsStringOrNull(object value)
        {
            return value as string;
        }
    }

    /// <summary>DslElement 属性取原始对象扩展（Engine 内聚使用；internal 面经
    /// InternalsVisibleTo 供测试复用）。</summary>
    internal static class TicketIrBuilderElementExtensions
    {
        /// <summary>等价 DslElement.Get 的 internal 复用面（避免扩公共 API）。</summary>
        public static object Get(this DslElement element, string key)
        {
            object value;
            return element.Attributes.TryGetValue(key ?? string.Empty, out value) ? value : null;
        }
    }
}
