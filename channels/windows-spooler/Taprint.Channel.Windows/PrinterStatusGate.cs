// SPDX-License-Identifier: Apache-2.0
#nullable disable
namespace Taprint.Channel.Windows
{
    /// <summary>
    /// 打印队列状态门·纯判定函数：状态 dword → 拒发原因真话（null=放行）。
    /// 状态来源＝调用方经 Winspool GetPrinter(level 2) 读出的 Status dword——
    /// **结构化封送取自 SpoolerNativeMethods.PRINTER_INFO_2.Status
    /// （x86@72 / x64@124），禁手工偏移**；探测调用按 Win32 语义必然「失败」
    /// 带回大小，返回值不可作判据——两段调用见通道实现。
    /// 判定优先级（与实现逐序一致）：离线＞缺纸＞卡纸＞开盖＞报错——
    /// 具体的可行动项（装纸/清纸/关门）先于泛化报错。
    /// </summary>
    public static class PrinterStatusGate
    {
        /// <summary>PRINTER_STATUS_* 位（winpool.h）：离线 0x80 / 缺纸 0x10 / 卡纸 0x08 / 报错 0x02 / 开盖 0x400000。</summary>
        public const int StatusOffline = 0x00000080;

        /// <summary>缺纸位。</summary>
        public const int StatusPaperOut = 0x00000010;

        /// <summary>卡纸位。</summary>
        public const int StatusPaperJam = 0x00000008;

        /// <summary>报错位。</summary>
        public const int StatusError = 0x00000002;

        /// <summary>开盖位。</summary>
        public const int StatusDoorOpen = 0x00400000;

        /// <summary>状态位 → 拒发原因真话（null=就绪放行）。判定优先级＝离线＞缺纸＞卡纸＞开盖＞报错（与实现逐序一致）。</summary>
        public static string GateReason(int statusDword)
        {
            if ((statusDword & StatusOffline) != 0)
            {
                return "打印机离线（请检查电源与连接线）";
            }

            if ((statusDword & StatusPaperOut) != 0)
            {
                return "打印机缺纸（装纸后重试）";
            }

            if ((statusDword & StatusPaperJam) != 0)
            {
                return "打印机卡纸（请清理后重试）";
            }

            if ((statusDword & StatusDoorOpen) != 0)
            {
                return "打印机仓盖未关";
            }

            if ((statusDword & StatusError) != 0)
            {
                return "打印机报错（请查看打印机面板指示）";
            }

            return null;
        }
    }
}
