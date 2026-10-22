// SPDX-License-Identifier: Apache-2.0
#nullable disable
using System;
using System.Collections.Generic;
using System.Text;

namespace Taprint.PrintDsl.Engine
{
    // ============================================================
    // TSPL 标签引擎：LabelTicketIr + 行数据 → TSPL 字节帧。
    //
    // 缝形态裁决（独立缝 ILabelTicketEngine）：ITicketEngine.Build(PrintTicketIr)
    // 是行序式小票 IR（行序列+列数承载），无画布尺寸/绝对坐标承载面；标签绝对坐标
    // 模型塞入 PrintTicketIr = TicketLine 越类读违约（TicketIr 注释禁越类读）或改
    // 冻结面 TicketIr。独立缝同构 ITicketEngine 形状（CommandSet+Build），
    // CommandSet 标识风格与渲染契约值域一致。
    //
    // CommandSet="tspl"：渲染契约值域 pdf|esc-pos|tspl|zpl|cpcl，与 esc-pos 主路同表。
    // 帧序（全序钉=帧序断言/一致性矩阵）：
    //   SIZE→[GAP|BLINE|（cont 不发）]→SPEED→DENSITY→SET TEAR→[DIRECTION]→CLS→
    //   元素集→PRINT n（份数=PRINT n 单帧承载；帧尾禁 FORMFEED——PRINT 在定位介质
    //   （GAP/BLINE）上已按传感器送出完整一张，再跟 FORMFEED=多走一张空白（真机
    //   定谳：黑标纸 2mm 档仍跟 1 张，撕纸假设与黑标高假设均排除后锁定此帧）；
    //   校准走纸链的 FORMFEED 保留——那边走纸就是目的）。
    // 设备参数链：模板显式值 > 设备键(deviceParams) > 引擎缺省（Default* 常量）；
    //   gapType=black→BLINE 代替 GAP（模板 gap 失效）；cont→两帧皆不发；
    //   SET TEAR 显式双态——off/未设也发 SET TEAR OFF：不发时打印机按固件缺省
    //   （很多机型缺省=每任务末送纸到撕纸位），表现为打完一张自动跟一张空白；
    //   DIRECTION 预留（deviceParams.Direction 有值才入帧）。
    //   deviceParams=null＝旧行为（模板缺省链，无新帧）。
    // 中文编码 GB18030（CodePages 提供程序注册——与 EscPosTicketEngine.ResolveGb18030
    // 同款范式；失败复用 PrintErrorCode.EncodingUnavailable 同语义不另立码）。
    // ============================================================

    /// <summary>标签引擎 seam：标签 IR + 行数据 → 标签方言字节（tspl 主路）。</summary>
    public interface ILabelTicketEngine
    {
        /// <summary>方言标识（风格对齐 ITicketEngine.CommandSet）。</summary>
        string CommandSet { get; }

        /// <summary>IR + 行数据（表达式求值域）+ 份数 → 送打字节帧。
        /// deviceParams（可选，null=旧行为）：设备级标签参数（间隙类型/浓度/速度/
        /// 撕纸/dpi 派生）；优先级=模板显式&gt;设备键&gt;引擎缺省。</summary>
        byte[] Build(LabelTicketIr label, IDictionary<string, object> data, int copies, LabelDeviceParams deviceParams = null);
    }

    /// <summary>TSPL 标签引擎实装（纯渲染面零 IO——送打归入口缝）。</summary>
    public sealed class TsplLabelEngine : ILabelTicketEngine
    {
        /// <summary>条码人读面缺省：附印（价签场景品读必要——schema 无此字段，引擎口径）。</summary>
        public const bool DefaultBarcodeHumanReadable = true;

        /// <summary>间隙缺省 mm（回落链末级：模板未给+设备未给——样例承袭值，
        /// 行为基线不变）。</summary>
        public const double DefaultGapMm = 2d;

        /// <summary>浓度缺省 0-15（同上——双样例一致值 8）。</summary>
        public const int DefaultDensity = 8;

        /// <summary>速度缺省档 1-10（同上——双样例一致值 4；真机上限标定属窗口核验）。</summary>
        public const int DefaultSpeed = 4;

        /// <summary>纸型间隙类型字面（gap/black/cont——LabelDeviceParams.GapType 值域）。</summary>
        public const string GapTypeBlack = "black";

        /// <summary>连续纸字面（cont——GAP/BLINE 皆不发）。</summary>
        public const string GapTypeCont = "cont";

        /// <summary>条码窄条宽缺省 dot（schema 无此字段——TSPL 通例档 2）。</summary>
        public const int DefaultBarcodeNarrowDots = 2;

        /// <summary>条码宽条宽缺省 dot（EAN 族比例由打印机内建——通例档 2）。</summary>
        public const int DefaultBarcodeWideDots = 2;

        /// <summary>QR 纠错档缺省 M（平衡档——ECC 域 L/M/Q/H）。</summary>
        public const string DefaultQrEccLevel = "M";

        /// <summary>QR 模式缺省 0=原码模式（手册通例——增强模式 1 登记真机核验）。</summary>
        public const int DefaultQrMode = 0;

        private readonly Encoding _gb18030;
        private readonly EngineLog _log;

        /// <summary>构造（log 可 null＝静默）。</summary>
        /// <param name="log">内核日志抽象（可 null）。</param>
        public TsplLabelEngine(EngineLog log)
        {
            _log = log ?? EngineLog.Silent;
            _gb18030 = ResolveGb18030();
        }

        /// <summary>方言名（渲染契约 commandSet 值域 tspl）。</summary>
        public string CommandSet
        {
            get { return "tspl"; }
        }

        /// <inheritdoc />
        public byte[] Build(LabelTicketIr label, IDictionary<string, object> data, int copies, LabelDeviceParams deviceParams = null)
        {
            if (label == null)
            {
                throw new ArgumentNullException("label");
            }

            if (copies < 1)
            {
                throw new ArgumentOutOfRangeException("copies", "份数至少 1（PRINT n 命令域）");
            }

            // ---- 参数解析（优先级链：模板显式 > 设备键 > 引擎缺省）----
            // gap 特例：设备 gapType=black 时模板 gap 值让位 BLINE 帧承载
            // （BLINE 代替 GAP，不是叠加）；cont=两帧皆不发（连续纸无定位）。
            string gapType = deviceParams != null && !string.IsNullOrEmpty(deviceParams.GapType)
                ? deviceParams.GapType
                : "gap";
            double gapMm = label.GapMm ?? (deviceParams != null ? deviceParams.GapMm : null)
                ?? DefaultGapMm;
            int density = label.Density ?? (deviceParams != null ? deviceParams.Density : null)
                ?? DefaultDensity;
            int speed = label.Speed ?? (deviceParams != null ? deviceParams.Speed : null)
                ?? DefaultSpeed;

            var frame = new List<byte>(512);
            frame.AddRange(TsplBuilder.Size(label.WidthMm, label.HeightMm));
            if (string.Equals(gapType, GapTypeCont, StringComparison.Ordinal))
            {
                // cont 连续纸：GAP/BLINE 皆不发。
            }
            else if (string.Equals(gapType, GapTypeBlack, StringComparison.Ordinal))
            {
                frame.AddRange(TsplBuilder.BLine(gapMm));
            }
            else
            {
                frame.AddRange(TsplBuilder.Gap(gapMm));
            }

            frame.AddRange(TsplBuilder.Speed(speed));
            frame.AddRange(TsplBuilder.Density(density));
            frame.AddRange(TsplBuilder.SetTear(deviceParams != null && deviceParams.TearOn == true));

            if (deviceParams != null && deviceParams.Direction.HasValue)
            {
                frame.AddRange(TsplBuilder.Direction(deviceParams.Direction.Value));   // 预留档位（帧序断言面）。
            }

            frame.AddRange(TsplBuilder.Cls());

            ExpressionScope scope = new ExpressionScope();
            scope.Push(data ?? new Dictionary<string, object>());
            for (int i = 0; i < label.Elements.Count; i++)
            {
                AppendElement(frame, label, label.Elements[i], scope);
            }

            frame.AddRange(TsplBuilder.Print(copies));
            return frame.ToArray();
        }

        // ---------- 元素面 ----------

        private void AppendElement(List<byte> frame, LabelTicketIr label, LabelElement element, ExpressionScope scope)
        {
            if (element.Kind == LabelElementKind.Unsupported)
            {
                _log.Warn("label 元素无 TSPL 映射，跳过（type=" + element.OriginalType + "——现役文本/条码/二维码/线框五面）");
                return;
            }

            // 越界裁剪策略：负坐标夹 0（贴边）；原点完全出画布=整元素丢弃
            // （绝对坐标越界会画进下一张标签物理面——禁越界出画）。
            int x = Math.Max(0, element.XDots);
            int y = Math.Max(0, element.YDots);
            if (x >= label.WidthDots || y >= label.HeightDots)
            {
                _log.Warn("label 元素坐标出画布，丢弃（" + x + "," + y + " 画布 " +
                    label.WidthDots + "x" + label.HeightDots + " type=" + element.OriginalType + "）");
                return;
            }

            string content = DslExpression.Substitute(element.Content, scope);
            switch (element.Kind)
            {
                case LabelElementKind.Text:
                    frame.AddRange(TsplBuilder.Text(x, y, element.FontName, 0,
                        element.FontMultiplication, element.FontMultiplication, content, _gb18030));
                    break;

                case LabelElementKind.Barcode:
                    frame.AddRange(TsplBuilder.Barcode(x, y, element.Symbology, element.HeightDots,
                        DefaultBarcodeHumanReadable, 0, DefaultBarcodeNarrowDots, DefaultBarcodeWideDots, content));
                    break;

                case LabelElementKind.QrCode:
                    frame.AddRange(TsplBuilder.QrCode(x, y, DefaultQrEccLevel, element.CellWidthDots,
                        DefaultQrMode, 0, content, _gb18030));
                    break;

                case LabelElementKind.Line:
                    // 分割线/粗线=BAR 实心矩形（w×h 单形；h 小=横线）。
                    frame.AddRange(TsplBuilder.Bar(x, y, element.WidthDots, element.HeightDots));
                    break;

                case LabelElementKind.Box:
                    // 线框矩形=BOX 五参帧（x,y,w,h,thickness）。
                    frame.AddRange(TsplBuilder.Box(x, y, element.WidthDots, element.HeightDots,
                        element.ThicknessDots));
                    break;
            }
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
                    "GB18030 编码不可用（System.Text.Encoding.CodePages 提供程序注册失败）——标签引擎无法落中文票面", ex);
            }
        }
    }
}
