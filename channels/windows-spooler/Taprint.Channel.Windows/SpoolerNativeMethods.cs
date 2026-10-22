// SPDX-License-Identifier: Apache-2.0
#nullable disable
using System.Runtime.InteropServices;

namespace Taprint.Channel.Windows
{
    /// <summary>
    /// Winspool.drv 打印池 P/Invoke 声明（按域拆分自上游单文件 NativeMethods——
    /// 上游另含 user32 低级键盘钩子分节，属扫码枪域而非打印域，不随本包移植）。
    /// P/Invoke 纪律：每函数注释来源与用途；单测禁触真实 P/Invoke 路径——
    /// 壳层只做胶水，纯逻辑拆独立类（PrinterStatusGate/PrinterActivator）测试。
    /// 声明跨平台编译（net8.0），调用仅在 Windows 运行时生效。
    ///
    /// 链路纪律（SpoolerRawPrinterChannel 承接）：
    /// OpenPrinter→StartDocPrinter(datatype=RAW)→StartPagePrinter→WritePrinter→
    /// EndPagePrinter→EndDocPrinter→ClosePrinter——句柄生命周期=EnsureOpen 开 /
    /// Dispose 或写失败时关；序列中途失败一律关句柄防泄漏。
    /// </summary>
    internal static class SpoolerNativeMethods
    {
        private const string WinspoolDll = "winspool.Drv";

        /// <summary>
        /// 取打印机句柄（来源=Microsoft Docs「Print Spooler API」Winspool.h）。
        /// phPrinter 收 HANDLE；pDefault 传 null 时走服务器默认设置——
        /// RAW 直写需显式 datatype=RAW 的默认值，故只用带 PRINTER_DEFAULTS 的重载形态。
        /// </summary>
        [DllImport(WinspoolDll, CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool OpenPrinter(
            string szPrinterName,
            out System.IntPtr hPrinter,
            System.IntPtr pDefault);

        /// <summary>关打印句柄（句柄生命周期终点；Open 成功后必须恰好一次）。</summary>
        [DllImport(WinspoolDll, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool ClosePrinter(System.IntPtr hPrinter);

        /// <summary>开始一个打印作业（Spooler 文档语境），返回 JobId。</summary>
        [DllImport(WinspoolDll, CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern int StartDocPrinter(System.IntPtr hPrinter, int level, ref DOC_INFO_1 docInfo);

        /// <summary>结束当前打印作业。</summary>
        [DllImport(WinspoolDll, SetLastError = true)]
        public static extern int EndDocPrinter(System.IntPtr hPrinter);

        /// <summary>开始一页。</summary>
        [DllImport(WinspoolDll, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool StartPagePrinter(System.IntPtr hPrinter);

        /// <summary>结束一页。</summary>
        [DllImport(WinspoolDll, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool EndPagePrinter(System.IntPtr hPrinter);

        /// <summary>往打印池写裸字节（RAW 数据直入队列由驱动/芯解析）。</summary>
        [DllImport(WinspoolDll, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool WritePrinter(System.IntPtr hPrinter, System.IntPtr buffer, int bytesToWrite, out int bytesWritten);

        /// <summary>查询打印机信息（level 2 布局；写前状态门用——两段调用：先探 cbNeeded
        /// 再取缓冲，读取走 PRINTER_INFO_2 结构化封送，禁手工偏移）。
        /// CharSet=Unicode 必给：缺省 Ansi 解析到 GetPrinterA，缓冲里 ANSI 串按
        /// LPWStr 解释会越界扫内存——结构体字符串字段是 LPWStr，A/W 必须一致。</summary>
        [DllImport(WinspoolDll, CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetPrinter(
            System.IntPtr hPrinter,
            int level,
            System.IntPtr pPrinter,
            int cbBuf,
            out int cbNeeded);

        /// <summary>
        /// PRINTER_INFO_2 完整形状（winpool.h 原型逐字段）。注意本结构
        /// **没有 Position 字段**（那是 JOB_INFO 系的）——真原型＝13 指针 + 8 dword
        /// （Attributes/Priority/DefaultPriority/StartTime/UntilTime/Status/cJobs/
        /// AveragePPM），x86 Status@72、x64 Status@124。误加 Position 会导致整表
        /// 错位一档（x64 读到 AveragePPM 恒 0＝状态门失效）——布局正确性由结构
        /// 原型注释钉死，禁再手改字段序。pDevMode/pSecurityDescriptor 本包不消费，
        /// 落 IntPtr 防深解引用；字符串走 LPWStr 自动解引用（GetPrinter 的串指针
        /// 指向同一缓冲区内）。
        /// </summary>
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct PRINTER_INFO_2
        {
            /// <summary>服务器名（LPWStr，缓冲区内串）。</summary>
            [MarshalAs(UnmanagedType.LPWStr)] public string pServerName;

            /// <summary>打印机名。</summary>
            [MarshalAs(UnmanagedType.LPWStr)] public string pPrinterName;

            /// <summary>共享名。</summary>
            [MarshalAs(UnmanagedType.LPWStr)] public string pShareName;

            /// <summary>端口名。</summary>
            [MarshalAs(UnmanagedType.LPWStr)] public string pPortName;

            /// <summary>驱动名。</summary>
            [MarshalAs(UnmanagedType.LPWStr)] public string pDriverName;

            /// <summary>注释。</summary>
            [MarshalAs(UnmanagedType.LPWStr)] public string pComment;

            /// <summary>位置。</summary>
            [MarshalAs(UnmanagedType.LPWStr)] public string pLocation;

            /// <summary>DEVMODE（不消费，指针承载）。</summary>
            public System.IntPtr pDevMode;

            /// <summary>分隔文件。</summary>
            [MarshalAs(UnmanagedType.LPWStr)] public string pSepFile;

            /// <summary>打印处理器。</summary>
            [MarshalAs(UnmanagedType.LPWStr)] public string pPrintProcessor;

            /// <summary>数据类型。</summary>
            [MarshalAs(UnmanagedType.LPWStr)] public string pDatatype;

            /// <summary>参数。</summary>
            [MarshalAs(UnmanagedType.LPWStr)] public string pParameters;

            /// <summary>安全描述符（不消费，指针承载）。</summary>
            public System.IntPtr pSecurityDescriptor;

            /// <summary>属性位（含 WORK_OFFLINE）。</summary>
            public uint Attributes;

            /// <summary>优先级。</summary>
            public uint Priority;

            /// <summary>缺省优先级。</summary>
            public uint DefaultPriority;

            /// <summary>起始时间。</summary>
            public uint StartTime;

            /// <summary>截止时间。</summary>
            public uint UntilTime;

            /// <summary>状态 dword（PrinterStatusGate 判定面）。</summary>
            public uint Status;

            /// <summary>队列中作业数。</summary>
            public uint cJobs;

            /// <summary>平均每分钟页数。</summary>
            public uint AveragePPM;
        }

        /// <summary>DOC_INFO_1 最小形状：winpool.h 原型即三字段（LPTSTR×3）；
        /// 作业号由 StartDocPrinter 返回值承载，不在结构体内。</summary>
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct DOC_INFO_1
        {
            /// <summary>文档名（队列里显示用——通道构造注入，宿主可自定义）。</summary>
            [MarshalAs(UnmanagedType.LPWStr)]
            public string DocName;

            /// <summary>输出文件名（null=送真实设备；仅 PRINTER 测试场景设文件路径）。</summary>
            [MarshalAs(UnmanagedType.LPWStr)]
            public string OutputFile;

            /// <summary>数据类型，RAW=原始字节流直投（驱动不做渲染）。</summary>
            [MarshalAs(UnmanagedType.LPWStr)]
            public string Datatype;
        }
    }
}
