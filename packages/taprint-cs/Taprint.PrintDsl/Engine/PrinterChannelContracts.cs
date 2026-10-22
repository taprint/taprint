// SPDX-License-Identifier: Apache-2.0
#nullable disable
using System;
using System.Threading;
using System.Threading.Tasks;

namespace Taprint.PrintDsl.Engine
{
    /// <summary>
    /// 通道异常基类（HAL 面类型化：调用方按形态分诊，禁裸 IOException 上串业务层）。
    /// </summary>
    public class PrinterChannelException : Exception
    {
        /// <summary>发案通道传输形态（serial/tcp/windows-spooler）。</summary>
        public string Transport { get; private set; }

        /// <summary>构造。</summary>
        /// <param name="transport">传输形态标识。</param>
        /// <param name="message">人读消息。</param>
        /// <param name="inner">内因异常（可 null）。</param>
        public PrinterChannelException(string transport, string message, Exception inner)
            : base(message, inner)
        {
            Transport = transport;
        }
    }

    /// <summary>连接阶段失败（打不开端口/连不上主机/拿不到驱动句柄）。</summary>
    public class PrinterConnectException : PrinterChannelException
    {
        /// <summary>构造。</summary>
        /// <param name="transport">传输形态标识。</param>
        /// <param name="message">人读消息。</param>
        /// <param name="inner">内因异常（可 null）。</param>
        public PrinterConnectException(string transport, string message, Exception inner)
            : base(transport, message, inner)
        {
        }
    }

    /// <summary>写数据阶段失败（IO 错误/断链/超时）。</summary>
    public class PrinterWriteException : PrinterChannelException
    {
        /// <summary>构造。</summary>
        /// <param name="transport">传输形态标识。</param>
        /// <param name="message">人读消息。</param>
        /// <param name="inner">内因异常（可 null）。</param>
        public PrinterWriteException(string transport, string message, Exception inner)
            : base(transport, message, inner)
        {
        }
    }

    /// <summary>
    /// 打印机通道 seam（会话内部件）：能力＝裸字节流送打；ESC/POS/TSPL 语义构造归
    /// 各构建器纯函数层，本 seam 不理解打印内容。参考实现三形态：
    ///   serial          = 串口（USB 虚拟 COM / 蓝牙 SPP 虚拟串口共用）；
    ///   tcp             = 网口直连（9100 RAW 端口透传）；
    ///   windows-spooler = Windows 打印池 RAW 投递（Win32 Spooler P/Invoke）。
    /// 前两形态是 raw 主路径，Spooler 是设备只装了厂商驱动时的兜底。
    /// 通道实装在 taprint 参考通道包（Taprint.Channel.Windows），内核只持有本契约。
    /// </summary>
    public interface IPrinterChannel : IDisposable
    {
        /// <summary>传输形态标识（serial/tcp/windows-spooler）。</summary>
        string Transport { get; }

        /// <summary>确保链路已建立（幂等；已开则直接返回）。失败抛 PrinterConnectException。</summary>
        void EnsureOpen();

        /// <summary>裸字节写入。失败抛 PrinterWriteException；成功即视为一次健康交互。</summary>
        Task WriteRawAsync(byte[] data, CancellationToken cancellationToken);
    }
}
