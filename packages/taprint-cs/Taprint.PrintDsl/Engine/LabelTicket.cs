// SPDX-License-Identifier: Apache-2.0
#nullable disable
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;

namespace Taprint.PrintDsl.Engine
{
    // ============================================================
    // 标签中间表示 + label 呈现 JSON 装载器。
    //
    // 字段面一手出处（禁想象字段）：
    //   - schema 权威：仓内 schema/v1.0.json+v2.0.json
    //     definitions.labelPresentation（size 必填/gap/density 0-15/speed 1-10/
    //     body minItems 1/copies/endCommand）与 labelElement（text{content,font,
    //     size 0-10}/barcode{content,symbology 六枚举}/qrcode{content,size 1-20}，
    //     元素 x/y 必填——负例 label-missing-xy.invalid.json 同口径）；
    //   - length 定义：带单位字符串 ^\d+(\.\d+)?(mm|cm|pt|px)$，mm 主单位，
    //     cm/pt/px「由渲染端换算」（schema length.description 原文）；
    //   - 预览口径：设计器画布预览器（LABEL_DOTS_PER_MM=8 即 203dpi；
    //     缺省纸面 40×30mm；块缺省 20×6mm）。
    //
    // 装载三态（冻结）：
    //   正常=全字段装载；缺字段兜底=schema 可选面（gap/density/speed/font/size/
    //   height/symbology/qr size）缺省化（缺省值出处逐项注释）；畸形报错=
    //   schema 必填面（size/body/x/y/content/type）违约抛 PrintDomainException
    //   （LabelPrintErrorCode.LabelIrMalformed——禁静默空打）。
    // 坐标口径：装载即 mm→dot 折算（×8 取整，203dpi），IR 全程点阵。
    // ============================================================

    /// <summary>标签元素种类（schema labelElement 支持面；Unsupported=无 TSPL 映射的合法元素，如 image）。</summary>
    public enum LabelElementKind
    {
        /// <summary>文本（content 可含 {{path}} 表达式；font 字库名+size 倍率）。</summary>
        Text = 1,

        /// <summary>条码（symbology 六码制枚举+height 高度）。</summary>
        Barcode = 2,

        /// <summary>二维码（size=模块格边长 dot 域）。</summary>
        QrCode = 3,

        /// <summary>首期无送打映射的合法元素（image/未知类型——引擎记日志跳过，不吞不炸）。</summary>
        Unsupported = 4,

        /// <summary>分割线/粗线（TSPL BAR 实心矩形承载——w×h 单形，h 小=横线；
        /// 字段形状 x/y/w+h 对齐设计器 schema 单形建议）。</summary>
        Line = 5,

        /// <summary>线框矩形（TSPL BOX 五参帧承载；thickness=线宽）。</summary>
        Box = 6,
    }

    /// <summary>标签 IR 元素（绝对坐标点阵；字段集随 Kind 取用）。</summary>
    public sealed class LabelElement
    {
        /// <summary>元素种类判别。</summary>
        public LabelElementKind Kind { get; set; }

        /// <summary>原始 type 串（Unsupported 诊断用；其余同枚举名小写）。</summary>
        public string OriginalType { get; set; }

        /// <summary>内容原文（含 {{path}} 表达式——行渲染期求值，装载期不求值）。</summary>
        public string Content { get; set; }

        /// <summary>X 坐标 dot（203dpi，画布左上原点）。</summary>
        public int XDots { get; set; }

        /// <summary>Y 坐标 dot。</summary>
        public int YDots { get; set; }

        /// <summary>Text：字库名（缺省 "SIMPLIFIED CHINESE"——设计器双样例通例）。</summary>
        public string FontName { get; set; }

        /// <summary>Text：宽高放大倍率 1-10（schema size 0-10，0=原寸折 1）。</summary>
        public int FontMultiplication { get; set; }

        /// <summary>Barcode：码制（CODE128/EAN13/UPC/EAN8/CODE39/ITF；缺省 CODE128——
        /// 预览器 blockText 缺省口径）。</summary>
        public string Symbology { get; set; }

        /// <summary>Barcode/Line/Box：元素高 dot（Barcode=条高缺省 48；Line=线粗缺省 4dot=0.5mm；
        /// Box=框高缺省 48——预览器块高兜底口径族）。</summary>
        public int HeightDots { get; set; }

        /// <summary>Line/Box：元素宽 dot（缺省 160=20mm×8——预览器块宽兜底口径）。</summary>
        public int WidthDots { get; set; }

        /// <summary>Box：线框线宽 dot（缺省 2；装载自 thickness mm）。</summary>
        public int ThicknessDots { get; set; }

        /// <summary>QrCode：模块格边长 dot（schema size 1-20 折 TSPL cell 域 1-10；缺省 4——TSPL 常用档）。</summary>
        public int CellWidthDots { get; set; }

        /// <summary>构造（种类判别+字段缺省面）。</summary>
        /// <param name="kind">元素种类。</param>
        public LabelElement(LabelElementKind kind)
        {
            Kind = kind;
            OriginalType = string.Empty;
            Content = string.Empty;
            FontName = "SIMPLIFIED CHINESE";
            FontMultiplication = 1;
            Symbology = "CODE128";
            HeightDots = 48;
            WidthDots = 160;
            ThicknessDots = 2;
            CellWidthDots = 4;
        }
    }

    /// <summary>标签 IR：画布尺寸（mm——SIZE 命令物理面）+点阵画布（dot——裁剪判域）+参数面+元素集。</summary>
    public sealed class LabelTicketIr
    {
        /// <summary>纸面宽 mm（SIZE 命令参数面）。</summary>
        public double WidthMm { get; set; }

        /// <summary>纸面高 mm。</summary>
        public double HeightMm { get; set; }

        /// <summary>标签间隙 mm（**可空=模板未显式给**——存在性承载：装载缺字段=null，
        /// 渲染期 null 才回落设备键→引擎缺省，禁装载器带设备缺省把存在性抹掉）。
        /// gap=间隙、设备 gapType=black 时本值作 BLINE 黑标线高。</summary>
        public double? GapMm { get; set; }

        /// <summary>浓度 0-15（**可空=模板未显式给**——回落链同 GapMm；越界夹界）。</summary>
        public int? Density { get; set; }

        /// <summary>速度 1-10（**可空=模板未显式给**——回落链同 GapMm；越界夹界）。</summary>
        public int? Speed { get; set; }

        /// <summary>元素集（body 序）。</summary>
        public IList<LabelElement> Elements { get; private set; }

        /// <summary>dots/mm（203dpi 工程值 8.0 缺省＝旧行为；300dpi=11.811——设备 labelDpi
        /// 派生经 Load(json, dotsPerMm) 注入）。</summary>
        public double DotsPerMm { get; set; }

        /// <summary>构造（40×30mm 缺省画布；GapMm/Density/Speed 刻意不起缺省——
        /// null=模板未给，引擎侧按 模板&gt;设备键&gt;引擎缺省 链解析）。</summary>
        public LabelTicketIr()
        {
            WidthMm = 40d;
            HeightMm = 30d;
            DotsPerMm = DslDimension.LabelDotsPerMmDefault;
            Elements = new List<LabelElement>();
        }

        /// <summary>画布宽 dot（按 IR.DotsPerMm 折算——越界裁剪判域）。</summary>
        public int WidthDots
        {
            get { return DslDimension.MmToDots(WidthMm, DotsPerMm); }
        }

        /// <summary>画布高 dot。</summary>
        public int HeightDots
        {
            get { return DslDimension.MmToDots(HeightMm, DotsPerMm); }
        }
    }

    /// <summary>label 呈现 JSON（presentations.label 切片）→ LabelTicketIr 装载器（纯函数零 IO）。</summary>
    public static class LabelTemplateLoader
    {
        private const string TextType = "text";
        private const string BarcodeType = "barcode";
        private const string QrCodeType = "qrcode";
        private const string LineType = "line";
        private const string BoxType = "box";

        /// <summary>
        /// 装载主入口。畸形（必填面违约）抛 PrintDomainException(LabelIrMalformed)
        /// ——禁静默空打；可选面缺省兜底（缺省值出处见 LabelTicketIr/LabelElement 字段注释）。
        /// </summary>
        public static LabelTicketIr Load(string labelJson)
        {
            return Load(labelJson, DslDimension.LabelDotsPerMmDefault);
        }

        /// <summary>dpi 感知装载（dotsPerMm 由调用方从设备 labelDpi 派生注入；
        /// 缺省重载=8.0 旧行为。≤0 防御回落 8.0）。</summary>
        public static LabelTicketIr Load(string labelJson, double dotsPerMm)
        {
            if (dotsPerMm <= 0d)
            {
                dotsPerMm = DslDimension.LabelDotsPerMmDefault;
            }

            if (string.IsNullOrWhiteSpace(labelJson))
            {
                throw Malformed("label 呈现 JSON 为空（模板装载链断裂——禁静默空打）");
            }

            JsonDocument document;
            try
            {
                document = JsonDocument.Parse(labelJson);
            }
            catch (JsonException ex)
            {
                throw Malformed("label 呈现非合法 JSON：" + ex.Message, ex);
            }

            using (document)
            {
                JsonElement root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object)
                {
                    throw Malformed("label 呈现根必须为对象（实际 " + root.ValueKind + "）");
                }

                LabelTicketIr ir = new LabelTicketIr();
                ir.DotsPerMm = dotsPerMm;
                ReadCanvas(root, ir);
                ReadElements(root, ir, dotsPerMm);
                return ir;
            }
        }

        // ---------- 画布与参数面 ----------

        /// <summary>size 必填（schema labelPresentation.required）——缺/非法=畸形；
        /// gap/density/speed 可选（可空存在性承载：缺/非法=null=模板未给，
        /// 在场值 schema bounds 夹取，越界夹界不炸——宽容面）。</summary>
        private static void ReadCanvas(JsonElement root, LabelTicketIr ir)
        {
            JsonElement size;
            if (!root.TryGetProperty("size", out size) || size.ValueKind != JsonValueKind.Object)
            {
                throw Malformed("label 呈现缺 size 对象（schema required——画布尺寸禁缺省猜测）");
            }

            double widthMm = ReadLengthMm(size, "width", 0d);
            double heightMm = ReadLengthMm(size, "height", 0d);
            if (widthMm <= 0d || heightMm <= 0d)
            {
                throw Malformed("label 呈现 size.width/height 非法（须为正长度，mm 主单位）");
            }

            ir.WidthMm = widthMm;
            ir.HeightMm = heightMm;

            // 可选参数面「存在性承载」：缺字段/非法形态=null（模板没说），
            // 引擎渲染期才回落设备键→引擎缺省——装载期缺省(2/8/4)会把存在性抹掉。
            double gapMm;
            if (TryReadLength(root, "gap", out gapMm))
            {
                ir.GapMm = gapMm;
            }

            ir.Density = ReadOptionalBoundedInt(root, "density", 0, 15);
            ir.Speed = ReadOptionalBoundedInt(root, "speed", 1, 10);
        }

        /// <summary>body 必填且非空（schema minItems 1）；元素逐个装载，x/y/type/content 必填。</summary>
        private static void ReadElements(JsonElement root, LabelTicketIr ir, double dotsPerMm)
        {
            JsonElement body;
            if (!root.TryGetProperty("body", out body) || body.ValueKind != JsonValueKind.Array ||
                body.GetArrayLength() == 0)
            {
                throw Malformed("label 呈现缺 body/空 body（schema minItems 1——空标签禁打）");
            }

            int index = 0;
            foreach (JsonElement raw in body.EnumerateArray())
            {
                index++;
                if (raw.ValueKind != JsonValueKind.Object)
                {
                    throw Malformed("label 元素 #" + index + " 必须为对象");
                }

                ir.Elements.Add(ReadElement(raw, index, dotsPerMm));
            }
        }

        /// <summary>单元素装载：text/barcode/qrcode 强类型；image/未知=Unsupported
        /// （schema 合法面但首期无 TSPL 映射——引擎跳过并记日志）。</summary>
        private static LabelElement ReadElement(JsonElement raw, int index, double dotsPerMm)
        {
            string type = ReadString(raw, "type");
            if (string.IsNullOrEmpty(type))
            {
                throw Malformed("label 元素 #" + index + " 缺 type");
            }

            LabelElement element;
            if (type == TextType)
            {
                element = new LabelElement(LabelElementKind.Text);
                element.FontName = ReadString(raw, "font");
                if (string.IsNullOrEmpty(element.FontName))
                {
                    element.FontName = "SIMPLIFIED CHINESE";
                }

                element.FontMultiplication = ReadBoundedInt(raw, "size", 1, 0, 10);
                if (element.FontMultiplication < 1)
                {
                    element.FontMultiplication = 1;   // size 0=原寸折 1（样例 size:0 通例）。
                }
            }
            else if (type == BarcodeType)
            {
                element = new LabelElement(LabelElementKind.Barcode);
                string symbology = ReadString(raw, "symbology");
                if (!string.IsNullOrEmpty(symbology))
                {
                    element.Symbology = symbology;
                }

                // 条高：length 承载（"8mm"×8 折 dot）；缺省 48=预览器块高 6mm 兜底。
                element.HeightDots = ReadLengthDots(raw, "height", element.HeightDots, dotsPerMm);
            }
            else if (type == QrCodeType)
            {
                element = new LabelElement(LabelElementKind.QrCode);
                // qr size：schema 1-20 整数；TSPL cell 域 1-10——折域夹取（20→10 映射降档，
                // 非报错：schema 合法值域优先于设备域，降档登记报告）。
                int size = ReadBoundedInt(raw, "size", element.CellWidthDots, 1, 20);
                element.CellWidthDots = Math.Min(size, 10);
            }
            else if (type == LineType)
            {
                // 分割线/粗线——BAR 承载。w/h 双键宽容（单形 w/h 主读，width/height
                // 兼容读——设计器 schema 落稿前双形等价，落稿后按回执对齐收窄）。
                element = new LabelElement(LabelElementKind.Line);
                element.WidthDots = ReadExtentDots(raw, "w", "width", element.WidthDots, dotsPerMm);
                element.HeightDots = ReadExtentDots(raw, "h", "height", element.HeightDots, dotsPerMm);
                if (element.HeightDots < 1)
                {
                    element.HeightDots = 1;   // 线粗下限 1dot（BAR 零高=不可见帧，禁静默丢）。
                }
            }
            else if (type == BoxType)
            {
                // 线框矩形——BOX 承载（五参帧：x,y,w,h,thickness）。
                element = new LabelElement(LabelElementKind.Box);
                element.WidthDots = ReadExtentDots(raw, "w", "width", element.WidthDots, dotsPerMm);
                element.HeightDots = ReadExtentDots(raw, "h", "height", element.HeightDots, dotsPerMm);
                element.ThicknessDots = Math.Max(1, ReadLengthDots(raw, "thickness", element.ThicknessDots, dotsPerMm));
                if (element.WidthDots < 1 || element.HeightDots < 1)
                {
                    element.WidthDots = Math.Max(1, element.WidthDots);
                    element.HeightDots = Math.Max(1, element.HeightDots);
                }
            }
            else
            {
                element = new LabelElement(LabelElementKind.Unsupported);
            }

            element.OriginalType = type;
            element.Content = ReadContent(raw, index, type);

            // x/y 必填（schema labelElement「绝对坐标（x/y 必填）」+负例 label-missing-xy 同口径）。
            double xMm;
            double yMm;
            if (!TryReadLength(raw, "x", out xMm) || !TryReadLength(raw, "y", out yMm))
            {
                throw Malformed("label 元素 #" + index + "（" + type + "）缺 x/y 绝对坐标（schema 必填）");
            }

            element.XDots = DslDimension.MmToDots(xMm, dotsPerMm);
            element.YDots = DslDimension.MmToDots(yMm, dotsPerMm);
            return element;
        }

        /// <summary>content 必填（三类**内容**元素 schema 均 required type+content；
        /// line/box=图形元素、Unsupported=未知类型——一律无 content 面返空，不进必填判）。</summary>
        private static string ReadContent(JsonElement raw, int index, string type)
        {
            if (type != TextType && type != BarcodeType && type != QrCodeType)
            {
                return string.Empty;
            }

            JsonElement content;
            if (!raw.TryGetProperty("content", out content))
            {
                throw Malformed("label 元素 #" + index + "（" + type + "）缺 content（schema required）");
            }

            string text = content.ValueKind == JsonValueKind.String ? content.GetString() : content.GetRawText();
            return text ?? string.Empty;
        }

        // ---------- length/int 读取原语 ----------

        /// <summary>length 串（^\d+(\.\d+)?(mm|cm|pt|px)$）→ mm；mm 主单位，
        /// cm/pt/px 按物理当量换算（schema「由渲染端换算」授权面）；数字形态宽容=mm。</summary>
        private static double ReadLengthMm(JsonElement parent, string name, double fallback)
        {
            double value;
            return TryReadLength(parent, name, out value) ? value : fallback;
        }

        /// <summary>
        /// length 读取：零值合法（gap 0mm=无间隙纸、坐标 0mm=画布原点均为正当承载），
        /// 仅拒负值与不可解析形态；正性约束归消费面（size 判 &gt;0，坐标/gap 允 0）。
        /// </summary>
        private static bool TryReadLength(JsonElement parent, string name, out double valueMm)
        {
            valueMm = 0d;
            JsonElement property;
            if (!parent.TryGetProperty(name, out property))
            {
                return false;
            }

            if (property.ValueKind == JsonValueKind.Number)
            {
                double number = property.GetDouble();
                if (number < 0d || double.IsNaN(number) || double.IsInfinity(number))
                {
                    return false;
                }

                valueMm = number;   // 宽容面：裸数字按 mm（schema 外形态，设计器恒发带单位串）。
                return true;
            }

            if (property.ValueKind != JsonValueKind.String)
            {
                return false;
            }

            string text = property.GetString();
            if (string.IsNullOrEmpty(text))
            {
                return false;
            }

            int end = text.Length;
            while (end > 0 && !char.IsDigit(text[end - 1]) && text[end - 1] != '.')
            {
                end--;
            }

            double number2;
            if (end == 0 ||
                !double.TryParse(text.Substring(0, end), NumberStyles.Float, CultureInfo.InvariantCulture, out number2) ||
                number2 < 0d)
            {
                return false;
            }

            string unit = text.Substring(end).Trim().ToLowerInvariant();
            if (unit == "mm" || unit.Length == 0)
            {
                valueMm = number2;
                return true;
            }

            if (unit == "cm")
            {
                valueMm = number2 * 10d;
                return true;
            }

            if (unit == "pt")
            {
                valueMm = number2 * 25.4d / 72d;
                return true;
            }

            if (unit == "px")
            {
                valueMm = number2 * 25.4d / 96d;
                return true;
            }

            return false;
        }

        /// <summary>length → dot（按装载 dotsPerMm 取整——条高等元素尺寸）。</summary>
        private static int ReadLengthDots(JsonElement parent, string name, int fallbackDots, double dotsPerMm)
        {
            double valueMm;
            return TryReadLength(parent, name, out valueMm)
                ? DslDimension.MmToDots(valueMm, dotsPerMm)
                : fallbackDots;
        }

        /// <summary>图形元素宽/高读取：主键（单形 w/h）缺时读兼容键（width/height——
        /// barcode height 同风格）；两键皆缺=fallback——禁必填猜测。</summary>
        private static int ReadExtentDots(JsonElement parent, string primaryName, string compatName,
            int fallbackDots, double dotsPerMm)
        {
            int value = ReadLengthDots(parent, primaryName, -1, dotsPerMm);
            if (value >= 0)
            {
                return value;
            }

            value = ReadLengthDots(parent, compatName, -1, dotsPerMm);
            return value >= 0 ? value : fallbackDots;
        }

        /// <summary>有界整数读取（schema bounds 夹取；缺失/非法/越界=夹界或 fallback，宽容面）。</summary>
        private static int ReadBoundedInt(JsonElement parent, string name, int fallback, int min, int max)
        {
            JsonElement property;
            if (!parent.TryGetProperty(name, out property) || property.ValueKind != JsonValueKind.Number)
            {
                return fallback;
            }

            int value = (int)Math.Round(property.GetDouble());
            return value < min ? min : (value > max ? max : value);
        }

        /// <summary>可空有界整数读取（存在性承载）：缺失/非数=null（模板未给）；
        /// 在场值夹界——模板显式越界仍算「给了」（夹到界内），与宽容面一致。</summary>
        private static int? ReadOptionalBoundedInt(JsonElement parent, string name, int min, int max)
        {
            JsonElement property;
            if (!parent.TryGetProperty(name, out property) || property.ValueKind != JsonValueKind.Number)
            {
                return null;
            }

            int value = (int)Math.Round(property.GetDouble());
            return value < min ? min : (value > max ? max : value);
        }

        private static string ReadString(JsonElement parent, string name)
        {
            JsonElement property;
            return parent.TryGetProperty(name, out property) && property.ValueKind == JsonValueKind.String
                ? property.GetString()
                : null;
        }

        private static PrintDomainException Malformed(string message, Exception inner = null)
        {
            return new PrintDomainException(LabelPrintErrorCode.LabelIrMalformed, message, inner);
        }
    }
}
