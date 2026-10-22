// SPDX-License-Identifier: Apache-2.0
#nullable disable
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;
using Taprint.PrintDsl.Engine;

namespace Taprint.Channel.Windows
{
    /// <summary>
    /// 网口打印机通道（TCP 直连裸字节写——多数网口芯监听 9100 端口透传打印流）。
    /// 连接超时/写超时参数化；参数键：host/port/connectTimeoutMs/writeTimeoutMs。
    /// </summary>
    public sealed class TcpPrinterChannel : IPrinterChannel
    {
        /// <summary>Transport 取值。</summary>
        public const string TransportName = "tcp";

        /// <summary>行业默认 RAW 端口 9100（JetDirect/ESC-POS 网口芯通用）。</summary>
        public const int DefaultPort = 9100;

        /// <summary>默认连接超时 ms。</summary>
        public const int DefaultConnectTimeoutMs = 3000;

        /// <summary>默认写超时 ms。</summary>
        public const int DefaultWriteTimeoutMs = 5000;

        private readonly string _host;
        private readonly int _port;
        private readonly int _connectTimeoutMs;
        private readonly int _writeTimeoutMs;

        // TcpClient 非线程安全；会话通道语义=单链单写，不引入锁复杂度，
        // 并发规约由宿主设备管理器单会话纪律保证（同一设备同时至多一个活动会话）。
        private TcpClient _client;
        private NetworkStream _stream;

        /// <summary>传输形态标识。</summary>
        public string Transport
        {
            get { return TransportName; }
        }

        /// <summary>构造。</summary>
        /// <param name="parameters">须含 host；port/connectTimeoutMs/writeTimeoutMs 可缺省。</param>
        public TcpPrinterChannel(IReadOnlyDictionary<string, string> parameters)
        {
            if (parameters == null)
            {
                throw new ArgumentNullException("parameters");
            }

            string host;
            if (!parameters.TryGetValue("host", out host) || string.IsNullOrWhiteSpace(host))
            {
                throw new ArgumentException("tcp 形态必须提供非空 host 参数。", "parameters");
            }

            _host = host.Trim();
            _port = SerialPrinterChannel.ReadIntParameter(parameters, "port", DefaultPort);
            _connectTimeoutMs = SerialPrinterChannel.ReadIntParameter(parameters, "connectTimeoutMs", DefaultConnectTimeoutMs);
            _writeTimeoutMs = SerialPrinterChannel.ReadIntParameter(parameters, "writeTimeoutMs", DefaultWriteTimeoutMs);

            if (_port < 1 || _port > 65535)
            {
                throw new ArgumentException("port 参数越界（1..65535）：" + _port.ToString(CultureInfo.InvariantCulture), "parameters");
            }
        }

        /// <summary>确保链路（幂等；带超时连接）。</summary>
        public void EnsureOpen()
        {
            if (_client != null && _client.Connected && _stream != null)
            {
                return;
            }

            DisposeQuietly();

            try
            {
                TcpClient client = new TcpClient();
                // ConnectAsync+等待=带超时连接的标准形态（同步 Connect 无超时参数，会撞 OS 级 TCP 超时 20s+）。
                IAsyncResult pending = client.BeginConnect(_host, _port, null, null);
                if (!pending.AsyncWaitHandle.WaitOne(_connectTimeoutMs))
                {
                    client.Dispose();
                    throw new PrinterConnectException(TransportName,
                        "网口打印机 " + _host + ":" + _port.ToString(CultureInfo.InvariantCulture) +
                        " 连接超时（" + _connectTimeoutMs.ToString(CultureInfo.InvariantCulture) + "ms）。", null);
                }

                client.EndConnect(pending);
                client.ReceiveTimeout = _writeTimeoutMs;
                client.SendTimeout = _writeTimeoutMs;
                _client = client;
                _stream = client.GetStream();
            }
            catch (PrinterConnectException)
            {
                throw;
            }
            catch (Exception ex)
            {
                if (ex is SocketException || ex is ObjectDisposedException || ex is ArgumentOutOfRangeException ||
                    ex is InvalidOperationException)
                {
                    throw new PrinterConnectException(TransportName,
                        "网口打印机 " + _host + ":" + _port.ToString(CultureInfo.InvariantCulture) + " 连接失败：" + ex.Message, ex);
                }

                throw;
            }
        }

        /// <summary>裸字节写入（类型化失败）。</summary>
        public Task WriteRawAsync(byte[] data, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();

            try
            {
                EnsureOpen();
                NetworkStream stream = _stream;
                if (stream == null)
                {
                    throw new PrinterWriteException(TransportName, "网络流为空：通道未就绪。", null);
                }

                return stream.WriteAsync(data, 0, data.Length, cancellationToken);
            }
            catch (PrinterChannelException)
            {
                throw;
            }
            catch (Exception ex)
            {
                if (ex is SocketException || ex is IOException || ex is ObjectDisposedException)
                {
                    DisposeQuietly();
                    throw new PrinterWriteException(TransportName, "网口写入失败：" + ex.Message, ex);
                }

                throw;
            }
        }

        /// <summary>释放链路。</summary>
        public void Dispose()
        {
            DisposeQuietly();
        }

        private void DisposeQuietly()
        {
            if (_stream != null)
            {
                try
                {
                    _stream.Dispose();
                }
                catch (IOException)
                {
                    // 清理噪声不上抛（Dispose 路径纪律）。
                }

                _stream = null;
            }

            if (_client != null)
            {
                try
                {
                    _client.Dispose();
                }
                catch (IOException)
                {
                    // 清理噪声不上抛（Dispose 路径纪律）。
                }

                _client = null;
            }
        }
    }
}
