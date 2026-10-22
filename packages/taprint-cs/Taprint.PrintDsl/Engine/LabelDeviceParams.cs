// SPDX-License-Identifier: Apache-2.0
#nullable disable
namespace Taprint.PrintDsl.Engine
{
    /// <summary>
    /// 标签设备参数载体（设备档案 → 标签链注入通路；内核内聚的精简形态）。
    ///
    /// 参数随设备走（禁全局单例）——上游参照形态是「设备描述符 → 强类型」装配点，
    /// 设备描述符属宿主设备域、不随引擎内核分发，故此处只承载引擎可消费的字段面
    /// （由宿主自行装配填充；全可空＝「设备没说」，非 0 值语义）。
    ///
    /// 优先级链（与 TsplLabelEngine 一致）：模板显式值 > 设备键 > 引擎缺省——
    /// 模板显式给=模板优先（设计意图），未给=设备键（硬件事实），都没有=引擎缺省。
    /// 存在性承载在 IR 可空字段（LabelTicketIr.GapMm/Density/Speed 为 null 才
    /// 回落设备键——禁装载器带设备缺省，会把存在性再次抹掉）。
    /// </summary>
    public sealed class LabelDeviceParams
    {
        /// <summary>纸型间隙类型：gap（间隙纸）/black（黑标纸）/cont（连续纸）。
        /// null=未设＝按 gap（既有行为基线）。</summary>
        public string GapType { get; set; }

        /// <summary>间隙/黑标高 mm（gap=标签间隙、black=黑标线高）。</summary>
        public double? GapMm { get; set; }

        /// <summary>浓度 0-15（越界由构建器夹界）。</summary>
        public int? Density { get; set; }

        /// <summary>速度 1-10 ips 档（真机实测上限属窗口核验项）。</summary>
        public int? Speed { get; set; }

        /// <summary>撕纸位送纸开关（on→SET TEAR ON；引擎按显式双态发帧）。</summary>
        public bool? TearOn { get; set; }

        /// <summary>dots/mm（键 labelDpi 派生：203→工程 8.0/300→11.811；恒有值，缺省 8.0）。</summary>
        public double DotsPerMm { get; set; }

        /// <summary>出图方向预留（TSPL DIRECTION；无设备键时引擎不发射——rotation
        /// 支持前的档位占位，帧序断言经本字段触发）。</summary>
        public int? Direction { get; set; }

        /// <summary>缺省构造（无设备键参与；DotsPerMm=203 工程 8.0）。</summary>
        public LabelDeviceParams()
        {
            DotsPerMm = DslDimension.LabelDotsPerMmDefault;
        }
    }
}
