// SPDX-License-Identifier: Apache-2.0
#nullable disable
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Taprint.PrintDsl.Engine;

namespace Taprint.Channel.Windows
{
    /// <summary>
    /// Windows 打印池 RAW 投递通道（USB 装驱形态）。链路纪律（见
    /// SpoolerNativeMethods 类头）：OpenPrinter→StartDocPrinter(datatype=RAW)→
    /// StartPagePrinter→WritePrinter→EndPagePrinter→EndDocPrinter→ClosePrinter——
    /// 句柄生命周期=EnsureOpen 开 / Dispose 或写失败时关；七步序列中途失败一律关
    /// 句柄防泄漏。失败映射：Win32 BOOL 假+GetLastError →
    /// PrinterConnectException/PrinterWriteException 类型化，Win32 错误码原文并入
    /// 消息（业务侧禁裸 Win32Error 上串）。
    /// 作业文档名（DocName，队列显示面）由构造注入——宿主按自家产品命名，
    /// 缺省=「taprint raw print」。
    /// </summary>
    public sealed class SpoolerRawPrinterChannel : IPrinterChannel
    {
        /// <summary>Transport 取值。</summary>
        public const string TransportName = "windows-spooler";

        /// <summary>缺省作业文档名（队列显示面）。</summary>
        public const string DefaultDocumentName = "taprint raw print";

        private readonly string _printerName;
        private readonly string _documentName;
        private IntPtr _handle = IntPtr.Zero;

        /// <summary>脱机探针 seam（测试注入；null=PrinterActivator.IsQueueOnline）。
        /// 显式 null 初始化（可变测试缝——CS0649 消解）。</summary>
        internal static Func<string, bool> QueueOnlineProbeOverride = null;

        /// <summary>传输形态标识。</summary>
        public string Transport
        {
            get { return TransportName; }
        }

        /// <summary>构造（文档名=缺省）。</summary>
        /// <param name="parameters">须含 printerName（Windows「设备和打印机」里的确切共享/本地名）。</param>
        public SpoolerRawPrinterChannel(IReadOnlyDictionary<string, string> parameters)
            : this(parameters, null)
        {
        }

        /// <summary>构造（文档名注入版）。</summary>
        /// <param name="parameters">须含 printerName。</param>
        /// <param name="documentName">RAW 作业文档名（队列显示面；null/空=缺省名）。</param>
        public SpoolerRawPrinterChannel(IReadOnlyDictionary<string, string> parameters, string documentName)
        {
            if (parameters == null)
            {
                throw new ArgumentNullException("parameters");
            }

            string printerName;
            if (!parameters.TryGetValue("printerName", out printerName) || string.IsNullOrWhiteSpace(printerName))
            {
                throw new ArgumentException("windows-spooler 形态必须提供非空 printerName 参数。", "parameters");
            }

            _printerName = printerName.Trim();
            _documentName = string.IsNullOrWhiteSpace(documentName) ? DefaultDocumentName : documentName.Trim();
        }

        /// <summary>连接=拿打印池句柄（幂等；重复调用不重开）。</summary>
        public void EnsureOpen()
        {
            if (_handle != IntPtr.Zero)
            {
                return;
            }

            IntPtr opened;
            if (!SpoolerNativeMethods.OpenPrinter(_printerName, out opened, IntPtr.Zero))
            {
                throw new PrinterConnectException(TransportName,
                    "打开打印池句柄失败：" + _printerName + "（Win32Error=" +
                    Marshal.GetLastWin32Error().ToString(System.Globalization.CultureInfo.InvariantCulture) + "）", null);
            }

            _handle = opened;
        }

        /// <summary>
        /// RAW 写入（三面防御全修）：①全部落后台线程离调用方 UI；②10s 写超时
        /// （Task.WhenAny 包装——超时=毒标记弃置本实例，禁硬关句柄：WritePrinter 无
        /// 取消面，ClosePrinter 与僵尸写并发未定义；后续写入读毒标记立即拒绝，重连
        /// 退避重建新实例）；③写前队列状态门（结构化封送 PRINTER_INFO_2）＋
        /// 同实例写入串行化（_writeGate——WritePrinter 并发交叠=字节流损坏）。
        /// 每次写入包成一页一作业；小票机场景无连页语义、按票提交故障隔离最干净。
        /// </summary>
        public Task WriteRawAsync(byte[] data, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (System.Threading.Volatile.Read(ref _poisoned) != 0)
            {
                throw new PrinterWriteException(TransportName,
                    "通道实例已因写入超时弃置，须走重连重建", null);
            }

            // 脱机硬拦截（全链唯一出口）：脱机队列照样收作业入队=静默积压的机制根源
            //（真机事故实证）。确证脱机即拒绝发送；探测失败 fail-open 放行。
            bool online = QueueOnlineProbeOverride != null
                ? QueueOnlineProbeOverride(_printerName)
                : PrinterActivator.IsQueueOnline(_printerName);
            if (!online)
            {
                throw new PrinterConnectException(TransportName,
                    "打印队列「" + _printerName + "」脱机——打印机没开或没连接，作业已拦截未发送（防止积压），请连接打印机后重试", null);
            }

            Task write = Task.Run(delegate
            {
                WriteRawBlocking(data, cancellationToken);
            }, cancellationToken);

            return WriteWithTimeoutAsync(write);
        }

        /// <summary>写超时（毫秒；10s——设备忙内核态阻塞秒级，超时弃置实例走重连）。</summary>
        private const int WriteTimeoutMs = 10000;

        /// <summary>写入毒标记（0=健康 1=超时弃置；Interlocked 语义，防僵尸写与后续写并发踩句柄）。</summary>
        private int _poisoned;

        /// <summary>写入串行闸（同实例 RAW 写禁并发交叠）。毒标记弃置后的后续写入在入口即拒
        /// （不排队）；闸只串行化健康写入。</summary>
        private readonly object _writeGate = new object();

        private async System.Threading.Tasks.Task WriteWithTimeoutAsync(Task write)
        {
            // ConfigureAwait(false) 两处皆必：调用链可能在同步上下文 .Wait() 本任务——
            // 默认上下文捕获会把续体 Post 回被阻塞的同步上下文＝死锁。
            // 通道层零 UI 依赖，全部走线程池续接。
            Task done = await Task.WhenAny(write, Task.Delay(WriteTimeoutMs)).ConfigureAwait(false);
            if (done != write)
            {
                System.Threading.Interlocked.Exchange(ref _poisoned, 1);
                // 僵尸写终局无人观察=UnobservedTaskException 面脏——挂观察续体吞掉。
                _ = write.ContinueWith(delegate (Task t)
                {
                    _ = t.Exception;
                }, TaskContinuationOptions.OnlyOnFaulted);
                throw new PrinterWriteException(TransportName,
                    "写入超时。请先确认打印机没出纸再重打（超时不等于没送出）", null);
            }

            await write.ConfigureAwait(false);   // 正常完成（含失败）＝原样传播真实结果
        }

        /// <summary>同步 RAW 写入体（后台线程执行；写前状态门＋全程持写闸）。
        /// 闸内毒复查：入口检查通过后排队等闸的写，可能在等待期间
        /// 实例被前者毒化（超时弃置）——闸内复查即拒，满足「实例弃置后任何新写不发生」。</summary>
        private void WriteRawBlocking(byte[] data, CancellationToken cancellationToken)
        {
            lock (_writeGate)
            {
                if (System.Threading.Volatile.Read(ref _poisoned) != 0)
                {
                    throw new PrinterWriteException(TransportName,
                        "通道实例已因写入超时弃置，须走重连重建", null);
                }

                EnsureOpen();
                GateByQueueStatus();

                SpoolerNativeMethods.DOC_INFO_1 doc = new SpoolerNativeMethods.DOC_INFO_1();
                doc.DocName = _documentName;
                doc.OutputFile = null;
                doc.Datatype = "RAW";

                int jobId = SpoolerNativeMethods.StartDocPrinter(_handle, 1, ref doc);
                if (jobId <= 0)
                {
                    int errorAtDoc = Marshal.GetLastWin32Error();
                    CloseHandleQuietly();
                    throw new PrinterWriteException(TransportName,
                        "StartDocPrinter 失败（JobId=" + jobId.ToString(System.Globalization.CultureInfo.InvariantCulture) +
                        " Win32Error=" + errorAtDoc.ToString(System.Globalization.CultureInfo.InvariantCulture) + "）", null);
                }

                try
                {
                    if (!SpoolerNativeMethods.StartPagePrinter(_handle))
                    {
                        throw new PrinterWriteException(TransportName,
                            "StartPagePrinter 失败（Win32Error=" +
                            Marshal.GetLastWin32Error().ToString(System.Globalization.CultureInfo.InvariantCulture) + "）", null);
                    }

                    try
                    {
                        int bytesWritten;
                        IntPtr buffer = Marshal.AllocHGlobal(data.Length);
                        try
                        {
                            Marshal.Copy(data, 0, buffer, data.Length);
                            if (!SpoolerNativeMethods.WritePrinter(_handle, buffer, data.Length, out bytesWritten))
                            {
                                throw new PrinterWriteException(TransportName,
                                    "WritePrinter 失败（Win32Error=" +
                                    Marshal.GetLastWin32Error().ToString(System.Globalization.CultureInfo.InvariantCulture) + "）", null);
                            }

                            if (bytesWritten != data.Length)
                            {
                                throw new PrinterWriteException(TransportName,
                                    "WritePrinter 短写：预期 " + data.Length.ToString(System.Globalization.CultureInfo.InvariantCulture) +
                                    " 实际 " + bytesWritten.ToString(System.Globalization.CultureInfo.InvariantCulture), null);
                            }
                        }
                        finally
                        {
                            Marshal.FreeHGlobal(buffer);
                        }
                    }
                    finally
                    {
                        if (!SpoolerNativeMethods.EndPagePrinter(_handle))
                        {
                            // 页收尾失败不上抛遮蔽主错误（数据已入池），登记消息留诊断即可；
                            // 此处保守策略=吞异常但保留 Win32 错误码在调试器可见面（不走日志面：通道层零依赖）。
                        }
                    }
                }
                finally
                {
                    if (SpoolerNativeMethods.EndDocPrinter(_handle) == 0)
                    {
                        // 同上：作业收尾失败不影响已投递数据，静默收尾。
                    }
                }
            }
        }

        /// <summary>释放句柄。</summary>
        public void Dispose()
        {
            CloseHandleQuietly();
        }

        /// <summary>写前队列状态门：PRINTER_INFO_2 结构化封送取 Status 位 → 拒发异常（真话）。
        /// 探测调用（pPrinter=NULL,cbBuf=0）按 Win32 语义必然返回 FALSE
        /// （GetLastError=ERROR_INSUFFICIENT_BUFFER=122）并回填所需大小——返回值不可作
        /// 成败判据，只认 cbNeeded。读不到大小（needed≤0，句柄失效等）＝放行不拦截
        /// （误拦比放行伤——离线/缺纸由面板兜底）。</summary>
        private void GateByQueueStatus()
        {
            int needed = 0;
            // 首调必然「失败」＝两段调用协议本身，返回值丢弃；needed 才是判据。
            SpoolerNativeMethods.GetPrinter(_handle, 2, IntPtr.Zero, 0, out needed);
            if (needed <= 0)
            {
                return;   // 拿不到所需大小＝探测失败，保守放行
            }

            IntPtr buffer = Marshal.AllocHGlobal(needed);
            try
            {
                int returned;
                if (!SpoolerNativeMethods.GetPrinter(_handle, 2, buffer, needed, out returned))
                {
                    return;
                }

                SpoolerNativeMethods.PRINTER_INFO_2 info =
                    (SpoolerNativeMethods.PRINTER_INFO_2)Marshal.PtrToStructure(buffer, typeof(SpoolerNativeMethods.PRINTER_INFO_2));
                string reason = PrinterStatusGate.GateReason((int)info.Status);
                if (reason != null)
                {
                    throw new PrinterWriteException(TransportName, reason, null);
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        private void CloseHandleQuietly()
        {
            if (_handle != IntPtr.Zero)
            {
                if (System.Threading.Volatile.Read(ref _poisoned) != 0)
                {
                    // 毒实例（超时弃置）：僵尸写可能仍在句柄上跑，ClosePrinter 与其并发未定义
                    // ——不关，句柄交进程回收（本设计原口径）。
                    _handle = IntPtr.Zero;
                    return;
                }

                SpoolerNativeMethods.ClosePrinter(_handle);
                _handle = IntPtr.Zero;
            }
        }
    }
}
