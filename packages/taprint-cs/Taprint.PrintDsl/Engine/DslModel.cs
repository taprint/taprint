// SPDX-License-Identifier: Apache-2.0
#nullable disable
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;

namespace Taprint.PrintDsl.Engine
{
    // ============================================================
    // 出票模板 DSL 模型层：后端下发 DSL（schema 驱动 JSON 树）
    // → 强类型元素树 → 绑定字段求值 → 设备无关中间表示（PrintTicketIr）。
    //
    // DSL 形态口径（取证源，禁改猜）：
    //   - 树遍历原语同构上游 Dart dsl_tree：presentations{receipt|doc|label}
    //     分区（doc 有 header/body/footer 三段，其余仅 body）；容器 loop.body /
    //     conditional.body / conditional.elseBody 递归下钻；
    //   - 元素集合同构上游票据仿真器布局元素 switch：
    //     text/line/cut/spacer/table/kvtable/image/qrcode/barcode/loop/
    //     conditional + 未知元素跳过（cashDrawer 等指令元素不进布局）；
    //   - 内容表达式 {{ path }} 替换（仿真器 substituteExpressions 同款
    //     花括号语义，本层手写扫描器免 Regex 依赖）；loop 遍历数据源行作用域、
    //     conditional 判真走 body 否则 elseBody——本实装全量行渲染（比仿真器
    //     「只渲染一轮」强的部分即出票引擎本份职责）。
    //
    // 与仓内内核解析面（Taprint.PrintDsl.DslParser，多语言 golden 钉字节级一致）
    // 的关系：本文件为出票域内最小自足解析面（票面元素树+行序 IR 语义），
    // 不与内核 golden 面互换；命名空间分层承载两者。
    // ============================================================

    /// <summary>呈现分区名常量（上游 dsl_tree 固定集）。</summary>
    internal static class DslSectionNames
    {
        /// <summary>doc 呈现的三段序（header/body/footer）。</summary>
        public static readonly string[] DocSections = { "header", "body", "footer" };

        /// <summary>receipt/label 呈现仅 body 段。</summary>
        public const string BodyOnly = "body";
    }

    /// <summary>
    /// 解析后的模板 DSL 文档（只读树；回读产物一次解析多处消费——
    /// 出票引擎每任务调用 Build 时传入 data 求值）。
    /// </summary>
    public sealed class DslDocument
    {
        /// <summary>paperWidthMm 缺省 80（仿真器 _paperWidthMm 兜底口径）。</summary>
        public double PaperWidthMm { get; set; }

        /// <summary>呈现分区顺序化序列（receipt→doc→label 优先级同上游 dsl_tree）。</summary>
        public IList<DslSection> Sections { get; private set; }

        /// <summary>构造（80mm 缺省）。</summary>
        public DslDocument()
        {
            PaperWidthMm = 80d;
            Sections = new List<DslSection>();
        }
    }

    /// <summary>呈现分区（presentation 名+段名+元素树）。</summary>
    public sealed class DslSection
    {
        /// <summary>'receipt' / 'doc' / 'label'。</summary>
        public string Presentation { get; private set; }

        /// <summary>'header' / 'body' / 'footer'。</summary>
        public string Name { get; private set; }

        /// <summary>分区根元素树。</summary>
        public IList<DslElement> Elements { get; private set; }

        /// <summary>构造。</summary>
        /// <param name="presentation">呈现名。</param>
        /// <param name="name">段名。</param>
        public DslSection(string presentation, string name)
        {
            Presentation = presentation;
            Name = name;
            Elements = new List<DslElement>();
        }
    }

    /// <summary>
    /// DSL 元素强类型化（type 判别字段的扁平承载——known 类型逐字段装箱进字典，
    /// Container 另持子树；样式原样保 Raw 序由引擎按需取，禁半解析漂移）。
    /// </summary>
    public sealed class DslElement
    {
        /// <summary>text/line/cut/spacer/table/kvtable/image/qrcode/barcode/loop/conditional/…原始 type。</summary>
        public string Type { get; set; }

        /// <summary>元素属性字典（type 外全部键；值为 string/double/bool/嵌套字典或列表的原生承载）。</summary>
        public IDictionary<string, object> Attributes { get; private set; }

        /// <summary>容器型 loop/conditional 的 body 子树；非容器恒空表。</summary>
        public IList<DslElement> Body { get; private set; }

        /// <summary>conditional 的 elseBody 子树；非条件恒空表。</summary>
        public IList<DslElement> ElseBody { get; private set; }

        /// <summary>构造。</summary>
        /// <param name="type">元素 type 判别串（可 null→空串）。</param>
        public DslElement(string type)
        {
            Type = type ?? string.Empty;
            Attributes = new Dictionary<string, object>();
            Body = new List<DslElement>();
            ElseBody = new List<DslElement>();
        }

        /// <summary>字符串属性安全取（缺失/类型不符 null）。</summary>
        public string Text(string key)
        {
            return DslValues.AsText(Get(key));
        }

        /// <summary>数值属性安全取（缺省 fallback；number 与数字串兼容）。</summary>
        public double Number(string key, double fallback)
        {
            return DslValues.AsNumber(Get(key), fallback);
        }

        /// <summary>对齐属性（left/center/right，缺省 left——仿真器 _alignOf 口径）。</summary>
        public string AlignOrLeft()
        {
            string align = Text("align");
            if (align == "center" || align == "right")
            {
                return align;
            }

            return "left";
        }

        private object Get(string key)
        {
            object value;
            return Attributes.TryGetValue(key ?? string.Empty, out value) ? value : null;
        }
    }

    /// <summary>DSL 值域工具（模型层与表达式求值共用）。</summary>
    internal static class DslValues
    {
        /// <summary>任意 DSL 标量 → 文本（string 直出/double InvariantCulture 整形化/bool true|false/null 空）。</summary>
        public static string AsText(object value)
        {
            if (value == null)
            {
                return string.Empty;
            }

            if (value is string)
            {
                return (string)value;
            }

            if (value is bool)
            {
                return (bool)value ? "true" : "false";
            }

            if (value is double)
            {
                return FormatNumber((double)value);
            }

            return value.ToString();
        }

        /// <summary>数值承载宽容取（double 主形态/long 数字形态/字符串解析；失败返 fallback）。</summary>
        public static double AsNumber(object value, double fallback)
        {
            if (value is double)
            {
                return (double)value;
            }

            if (value is long)
            {
                return (long)value;
            }

            string text = value as string;
            if (text != null &&
                double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out double parsed))
            {
                return parsed;
            }

            return fallback;
        }

        /// <summary>JSON 数字的文本整形（整数不带小数点；5.0 打印为 "5" 不是 "5,0"/"5.0" 漂移面收口；
        /// ADR-0009：钉死 InvariantCulture 形态，禁平台默认浮点转串）。</summary>
        public static string FormatNumber(double value)
        {
            if (value == Math.Floor(value) && !double.IsInfinity(value))
            {
                return ((long)value).ToString(CultureInfo.InvariantCulture);
            }

            return value.ToString(CultureInfo.InvariantCulture);
        }
    }

    /// <summary>
    /// 出票 DSL 解析器（JsonDocument → DslDocument；非对象 DSL / 无 presentations 即空文档，
    /// 解析层零抛业务异常——形态级错误抛 PrintDomainException(DslParseFailed)）。
    /// 与内核 Taprint.PrintDsl.DslParser（golden 面）非同一类型，分属两层。
    /// </summary>
    public static class DslParser
    {
        /// <summary>呈现优先级（上游 dsl_tree _presentationOrder 同序）。</summary>
        private static readonly string[] PresentationOrder = { "receipt", "doc", "label" };

        /// <summary>解析 JSON 正文为文档树（空白正文=解析失败——形态级错误防御位）。</summary>
        public static DslDocument Parse(string dslJson)
        {
            if (string.IsNullOrWhiteSpace(dslJson))
            {
                throw new PrintDomainException(PrintErrorCode.DslParseFailed, "print_dsl 正文为空");
            }

            JsonDocument document;
            try
            {
                document = JsonDocument.Parse(dslJson);
            }
            catch (JsonException ex)
            {
                throw new PrintDomainException(PrintErrorCode.DslParseFailed, "print_dsl 非法 JSON：" + ex.Message, ex);
            }

            using (document)
            {
                JsonElement root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object)
                {
                    throw new PrintDomainException(PrintErrorCode.DslParseFailed,
                        "print_dsl 根必须为对象（实际 " + root.ValueKind + "）");
                }

                DslDocument doc = new DslDocument();
                doc.PaperWidthMm = ReadPaperWidth(root);
                JsonElement presentations;
                if (!root.TryGetProperty("presentations", out presentations) ||
                    presentations.ValueKind != JsonValueKind.Object)
                {
                    return doc;   // 无呈现=空文档（打印即空票面；调用方可按需拒）。
                }

                foreach (string presentationName in PresentationOrder)
                {
                    JsonElement presentation;
                    if (!presentations.TryGetProperty(presentationName, out presentation) ||
                        presentation.ValueKind != JsonValueKind.Object)
                    {
                        continue;
                    }

                    AddSections(doc, presentationName, presentation);
                }

                return doc;
            }
        }

        /// <summary>纸宽解析（presentations[p].widthmm|width|"58mm" 承载，毫米数；≤0 或缺失走 80 缺省）。</summary>
        private static double ReadPaperWidth(JsonElement root)
        {
            JsonElement presentations;
            if (!root.TryGetProperty("presentations", out presentations) ||
                presentations.ValueKind != JsonValueKind.Object)
            {
                return 80d;
            }

            foreach (string presentationName in PresentationOrder)
            {
                JsonElement presentation;
                if (!presentations.TryGetProperty(presentationName, out presentation) ||
                    presentation.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                JsonElement widthProperty;
                if ((!presentation.TryGetProperty("width", out widthProperty) ||
                     widthProperty.ValueKind != JsonValueKind.String) &&
                    !presentation.TryGetProperty("widthmm", out widthProperty))
                {
                    continue;
                }

                string raw = widthProperty.ValueKind == JsonValueKind.String
                    ? widthProperty.GetString()
                    : widthProperty.GetRawText();
                double parsed = ParseWidthMm(raw);
                if (parsed > 0d)
                {
                    return parsed;
                }
            }

            return 80d;
        }

        /// <summary>"80mm"/"58"/80 形态 → 毫米数（非数尾缀剥离；非法返 -1 由调用方兜底）。
        /// dotsPerMm 仅作用于 dot 后缀启发式（小票域冻结 203=8——label 域不走本路径，
        /// 走 LabelTemplateLoader；参数化防 300dpi 未来误用双重折算）。</summary>
        private static double ParseWidthMm(string raw, double dotsPerMm = 8d)
        {
            if (string.IsNullOrEmpty(raw))
            {
                return -1d;
            }

            int end = raw.Length;
            while (end > 0 && !char.IsDigit(raw[end - 1]) && raw[end - 1] != '.')
            {
                end--;
            }

            double parsed;
            if (end == 0 ||
                !double.TryParse(raw.Substring(0, end), NumberStyles.Float, CultureInfo.InvariantCulture, out parsed))
            {
                return -1d;
            }

            // mm/dot 双单位兜底：宽度以 dot 表达且值可疑大时按 dotsPerMm 折算（203 冻结口径；
            // 阈值>200 与折算基准随参数化——歧义高危区，schema 单位显式化后废弃）。
            string tail = raw.Substring(end).Trim().ToLowerInvariant();
            if ((tail == "dot" || tail == "dots") && parsed > 200d)
            {
                return parsed / dotsPerMm;
            }

            return parsed;
        }

        /// <summary>单呈现下段枚举（doc 三段序；其余仅 body），段内容须为数组才收录（上游同门槛）。</summary>
        private static void AddSections(DslDocument doc, string presentationName, JsonElement presentation)
        {
            string[] sectionNames = presentationName == "doc"
                ? DslSectionNames.DocSections
                : new[] { DslSectionNames.BodyOnly };

            foreach (string sectionName in sectionNames)
            {
                JsonElement elements;
                if (!presentation.TryGetProperty(sectionName, out elements) || elements.ValueKind != JsonValueKind.Array)
                {
                    continue;
                }

                DslSection section = new DslSection(presentationName, sectionName);
                FillElements(section.Elements, elements);
                if (section.Elements.Count > 0)
                {
                    doc.Sections.Add(section);
                }
            }
        }

        /// <summary>JsonArray → 元素子树递归装配。</summary>
        private static void FillElements(IList<DslElement> target, JsonElement array)
        {
            foreach (JsonElement raw in array.EnumerateArray())
            {
                if (raw.ValueKind != JsonValueKind.Object)
                {
                    continue;   // 非 map 元素直接忽略（上游 collectElements 同门槛）。
                }

                DslElement element = BuildElement(raw);
                if (element != null)
                {
                    target.Add(element);
                }
            }
        }

        /// <summary>单元素装配（type 判别 + 属性字典 + 容器递归）。</summary>
        private static DslElement BuildElement(JsonElement raw)
        {
            string type = null;
            JsonElement typeProperty;
            if (raw.TryGetProperty("type", out typeProperty) && typeProperty.ValueKind == JsonValueKind.String)
            {
                type = typeProperty.GetString();
            }

            var element = new DslElement(type);
            foreach (JsonProperty property in raw.EnumerateObject())
            {
                if (property.Name == "type")
                {
                    continue;
                }

                if (property.Name == "body" && property.Value.ValueKind == JsonValueKind.Array)
                {
                    FillElements(element.Body, property.Value);
                    continue;
                }

                if (property.Name == "elseBody" && property.Value.ValueKind == JsonValueKind.Array)
                {
                    FillElements(element.ElseBody, property.Value);
                    continue;
                }

                element.Attributes[property.Name] = DslValuesReader.Read(property.Value);
            }

            return element;
        }
    }

    /// <summary>JsonElement → CLR 原生承载读取器（string/double/bool/Dictionary/List 复合原样保形）。</summary>
    internal static class DslValuesReader
    {
        /// <summary>递归读取 JsonElement 为 CLR 原生对象。</summary>
        public static object Read(JsonElement element)
        {
            switch (element.ValueKind)
            {
                case JsonValueKind.String:
                    return element.GetString();
                case JsonValueKind.Number:
                    return element.GetDouble();
                case JsonValueKind.True:
                    return true;
                case JsonValueKind.False:
                    return false;
                case JsonValueKind.Object:
                    Dictionary<string, object> map = new Dictionary<string, object>();
                    foreach (JsonProperty property in element.EnumerateObject())
                    {
                        map[property.Name] = Read(property.Value);
                    }

                    return map;
                case JsonValueKind.Array:
                    List<object> list = new List<object>();
                    foreach (JsonElement item in element.EnumerateArray())
                    {
                        list.Add(Read(item));
                    }

                    return list;
                default:
                    return null;   // Null/Undefined 统一「无值」。
            }
        }
    }
}
