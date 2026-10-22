// SPDX-License-Identifier: Apache-2.0
#nullable disable
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Ports;
using System.Threading;
using System.Threading.Tasks;
using Taprint.PrintDsl.Engine;

namespace Taprint.Channel.Windows
{
    /// <summary>
    /// 串口打印机通道（System.IO.Ports.SerialPort）。覆盖两形态：
    /// ① USB 虚拟 COM（VCP 驱动把 USB 打印机枚举为 COMx）；
    /// ② 蓝牙 SPP 配对后的虚拟串口——依赖系统配对，应用层只认虚拟 COM 名
    /// （未核验登记：配对流程本身）。
    /// 参数化波特率/数据位/停止位；默认 9600-8-N-1 的理由（注释口径）：
    /// 国产 ESC/POS 兼容芯出厂即 9600 且规格书默认标注一致、无流控要求；
    /// 波特率不匹配的症状=乱码而非失败，故参数必须随设备配置页暴露可改。
    /// </summary>
    public sealed class SerialPrinterChannel : IPrinterChannel
    {
        /// <summary>Transport 取值。</summary>
        public const string TransportName = "serial";

        private readonly string _portName;
        private readonly int _baudRate;
        private readonly int _dataBits;
        private readonly StopBits _stopBits;
        private SerialPort _port;

        /// <summary>传输形态标识。</summary>
        public string Transport
        {
            get { return TransportName; }
        }

        /// <summary>构造。</summary>
        /// <param name="parameters">至少须含 portName；baudRate/dataBits/stopBits 缺省=9600-8-N-1。</param>
        public SerialPrinterChannel(IReadOnlyDictionary<string, string> parameters)
        {
            if (parameters == null)
            {
                throw new ArgumentNullException("parameters");
            }

            string portName;
            if (!parameters.TryGetValue("portName", out portName) || string.IsNullOrWhiteSpace(portName))
            {
                throw new ArgumentException("serial 形态必须提供非空 portName 参数。", "parameters");
            }

            _portName = portName.Trim();
            _baudRate = ReadIntParameter(parameters, "baudRate", 9600);
            _dataBits = ReadIntParameter(parameters, "dataBits", 8);

            StopBits parsedStopBits = StopBits.One;
            string stopBitsRaw;
            if (parameters.TryGetValue("stopBits", out stopBitsRaw) &&
                !Enum.TryParse<StopBits>(stopBitsRaw, true, out parsedStopBits))
            {
                throw new ArgumentException("stopBits 参数无法解析为 StopBits 枚举：" + stopBitsRaw, "parameters");
            }

            _stopBits = parsedStopBits;
        }

        /// <summary>连接=打开端口。SerialPort.Open 同步但通常毫秒级；幂等。</summary>
        public void EnsureOpen()
        {
            if (_port != null && _port.IsOpen)
            {
                return;
            }

            try
            {
                SerialPort port = new SerialPort(_portName, _baudRate, Parity.None, _dataBits, _stopBits);
                // 写超时兜底：写阻塞（对端异常挂起）超 5s 视为断链走重连，防业务线程永挂。
                port.WriteTimeout = 5000;
                port.Open();
                _port = port;
            }
            catch (Exception ex)
            {
                if (ex is UnauthorizedAccessException || ex is IOException || ex is InvalidOperationException ||
                    ex is ArgumentOutOfRangeException || ex is ArgumentException)
                {
                    throw new PrinterConnectException(
                        TransportName,
                        "串口 " + _portName + "（" + _baudRate.ToString(CultureInfo.InvariantCulture) + "-" +
                        _dataBits.ToString(CultureInfo.InvariantCulture) + "-" + _stopBits + "）打开失败：" + ex.Message,
                        ex);
                }

                throw;
            }
        }

        /// <summary>
        /// 写入实现。取消面：SerialPort.Write 无异步形态且句柄不可等，
        /// 本通道以「写入前检查 ct」为取消点（毫秒级同步写，属可接受妥协——登记于类头）。
        /// </summary>
        public Task WriteRawAsync(byte[] data, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();

            try
            {
                EnsureOpen();
                _port.Write(data, 0, data.Length);
                return Task.CompletedTask;
            }
            catch (PrinterChannelException)
            {
                throw;
            }
            catch (TimeoutException ex)
            {
                throw new PrinterWriteException(TransportName, "串口写入超时（5s）：视作断链。", ex);
            }
            catch (Exception ex)
            {
                if (ex is UnauthorizedAccessException || ex is IOException || ex is InvalidOperationException)
                {
                    DisposePortQuietly();
                    throw new PrinterWriteException(TransportName, "串口写入失败：" + ex.Message, ex);
                }

                throw;
            }
        }

        /// <summary>释放端口。</summary>
        public void Dispose()
        {
            DisposePortQuietly();
        }

        private void DisposePortQuietly()
        {
            if (_port != null)
            {
                try
                {
                    _port.Dispose();
                }
                catch (IOException)
                {
                    // 句柄回收阶段的 IO 尾巴不再上抛（Dispose 纪律：禁吞主流程错误，可吞清理噪声）。
                }

                _port = null;
            }
        }

        /// <summary>整型参数读取（缺失=fallback；不可解析=ArgumentException——与越界分开说话）。</summary>
        /// <param name="parameters">参数字典。</param>
        /// <param name="key">参数键。</param>
        /// <param name="fallback">缺省值。</param>
        /// <returns>解析值。</returns>
        internal static int ReadIntParameter(IReadOnlyDictionary<string, string> parameters, string key, int fallback)
        {
            string raw;
            if (!parameters.TryGetValue(key, out raw) || string.IsNullOrWhiteSpace(raw))
            {
                return fallback;
            }

            int value;
            if (!int.TryParse(raw.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out value))
            {
                throw new ArgumentException(key + " 参数无法解析为整数：" + raw, "parameters");
            }

            return value;
        }
    }
}
