// SPDX-License-Identifier: Apache-2.0
#nullable disable
using System;
using System.Collections.Generic;
using System.Diagnostics;
using Microsoft.Win32;

namespace Taprint.Channel.Windows
{
    /// <summary>
    /// 队列设置失败分类码（通道层只报码与中性文案；宿主可经
    /// <see cref="PrinterSetupMessages.SetResolver"/> 覆盖为带自家操作指引的文案）。
    /// </summary>
    public enum PrinterSetupError
    {
        /// <summary>无错误（成功）。</summary>
        None = 0,

        /// <summary>读不到打印机端口（无法自动绑定队列）。</summary>
        PortUnreadable = 1,

        /// <summary>printui 建队列失败（最常见=非管理员会话，printui 需提权）。</summary>
        QueueCreateFailed = 2,

        /// <summary>回读校验：队列键不存在。</summary>
        VerifyQueueMissing = 3,

        /// <summary>回读校验：驱动不是 Generic / Text Only。</summary>
        VerifyDriverMismatch = 4,

        /// <summary>回读校验：端口与设备端口对不上。</summary>
        VerifyPortMismatch = 5,
    }

    /// <summary>
    /// 队列设置失败文案目录：默认=通道层中性文案（不含任何宿主 UI 操作指引）；
    /// 宿主注入 resolver 后按码取自家话术（如「以管理员身份重新运行设置」的
    /// 具体入口路径）。Resolve 两面皆 never-throw。
    /// </summary>
    public static class PrinterSetupMessages
    {
        private static Func<PrinterSetupError, string> _resolver;

        /// <summary>注入宿主文案解析器（null=恢复默认中性文案）。</summary>
        /// <param name="resolver">码→文案（返回 null/异常时回落默认文案）。</param>
        public static void SetResolver(Func<PrinterSetupError, string> resolver)
        {
            _resolver = resolver;
        }

        /// <summary>按码取文案（宿主覆盖优先；失败回落默认）。</summary>
        /// <param name="error">失败分类码。</param>
        /// <returns>人读文案。</returns>
        public static string Resolve(PrinterSetupError error)
        {
            if (_resolver != null)
            {
                try
                {
                    string text = _resolver(error);
                    if (!string.IsNullOrEmpty(text))
                    {
                        return text;
                    }
                }
                catch
                {
                    // 文案面 never-throw：解析器异常回落默认。
                }
            }

            return DefaultText(error);
        }

        private static string DefaultText(PrinterSetupError error)
        {
            switch (error)
            {
                case PrinterSetupError.PortUnreadable:
                    return "读不到这台打印机的端口，无法设置。";
                case PrinterSetupError.QueueCreateFailed:
                    return "创建打印队列失败（常见原因=需要管理员权限）：请以管理员权限重试后再设置。";
                case PrinterSetupError.VerifyQueueMissing:
                    return "设置未完成：打印队列未就绪，请重试（必要时以管理员权限运行）。";
                case PrinterSetupError.VerifyDriverMismatch:
                    return "设置未完成：打印驱动不是 Generic / Text Only，请重试。";
                case PrinterSetupError.VerifyPortMismatch:
                    return "设置未完成：打印机端口不匹配，请重新连接打印机后再设置。";
                default:
                    return null;
            }
        }
    }

    /// <summary>
    /// 队列设置遥测 SPI：宿主注入 (kind, detail) 记录器（未注入=静默——通道层零依赖
    /// 纪律，不内置遥测落盘）。两键=queueCreated/queueCreateFailed。
    /// </summary>
    public static class PrinterActivatorTelemetry
    {
        /// <summary>队列创建成功事件键。</summary>
        public const string QueueCreated = "queueCreated";

        /// <summary>队列创建失败事件键。</summary>
        public const string QueueCreateFailed = "queueCreateFailed";

        /// <summary>遥测记录委托（宿主注入；null=静默）。never-throw 纪律归宿主侧。</summary>
        public static Action<string, string> Record { get; set; }
    }

    /// <summary>
    /// USB 打印机自动激活：USBPRINT 实例在册但无 Text-Only 打印队列时，静默调用
    /// printui.dll /if 创建 Generic / Text Only 队列绑 USB00x（POS 业界标准接法——
    /// RAW 直通不经厂商驱动）。
    ///
    /// 提权口径：建队列需管理员；非管理员会话调用失败（exit code 非 0）
    /// ⇒ 返回 false（<see cref="PrinterSetupError.QueueCreateFailed"/>）由宿主引导
    /// 「管理员身份运行」，禁假成功（诚实降级纪律）。失败文案走
    /// <see cref="PrinterSetupMessages"/>（宿主可覆盖）。
    /// </summary>
    public static class PrinterActivator
    {
        /// <summary>
        /// Text-Only 队列命名（确定性；可读形「Label 型号 端口」——原取实例尾段
        /// 会得 "Label 8&amp;2cf84813&amp;0&amp;USB001" 之类内部路径，直接出现在打印面板
        /// 下拉里不可读。型号段＝USBPRINT 下父键名（如 HPRTTP582），端口缺失时回退
        /// 实例尾段保唯一）。
        /// </summary>
        /// <param name="instanceId">USB 实例全路径。</param>
        /// <param name="portName">USB 端口名（USB00x）。</param>
        /// <returns>确定性队列名。</returns>
        public static string BuildQueueName(string instanceId, string portName)
        {
            string model = ExtractSegment(instanceId, 1);
            string tail = !string.IsNullOrWhiteSpace(portName) ? portName.Trim() : ExtractSegment(instanceId, 2);
            string name = string.IsNullOrWhiteSpace(model) ? "Label " + tail : "Label " + model + " " + tail;

            foreach (char illegal in new[] { '\\', '/', ',', ';', '"', '\t', '\r', '\n' })
            {
                name = name.Replace(illegal, '_');
            }

            return name;
        }

        /// <summary>取反斜杠分段（0=USBPRINT、1=型号、2=实例；段不足回空串）。</summary>
        private static string ExtractSegment(string instanceId, int index)
        {
            if (string.IsNullOrWhiteSpace(instanceId))
            {
                return string.Empty;
            }

            string[] parts = instanceId.Split('\\');
            return index < parts.Length ? parts[index] : string.Empty;
        }

        /// <summary>
        /// 确保 Text-Only 队列在位（语义=「自家队列在 ⇒ true；否则一律创建自家队列
        /// ＋回读校验」；false 仅真失败。复用他人队列返回 true 但自家队列并未创建
        /// ⇒ 后续向自家确定性名发字节必败（Win32=1801 错型实证）——禁复用即就绪）。
        /// 同端口多队列无害——指名打自家队列，spooler 端口串行。
        /// </summary>
        /// <param name="instanceId">USB 实例全路径。</param>
        /// <param name="usbPortName">USB 端口名。</param>
        /// <param name="error">失败分类码（成功=None）。</param>
        /// <param name="failureText">失败文案（经 PrinterSetupMessages 解析；成功=null）。</param>
        /// <returns>成功与否。</returns>
        public static bool EnsureTextOnlyQueue(string instanceId, string usbPortName,
            out PrinterSetupError error, out string failureText)
        {
            error = PrinterSetupError.None;
            failureText = null;
            if (string.IsNullOrWhiteSpace(instanceId) || string.IsNullOrWhiteSpace(usbPortName))
            {
                error = PrinterSetupError.PortUnreadable;
                failureText = PrinterSetupMessages.Resolve(error);
                return false;
            }

            string queueName = BuildQueueName(instanceId, usbPortName);
            if (QueueExists(queueName))
            {
                return true;
            }

            string args = BuildPrintUiArgs(queueName, usbPortName);
            if (!RunPrintUi(args))
            {
                // 建队列失败最常见=非管理员会话（printui 需提权）——诚实提权引导。
                error = PrinterSetupError.QueueCreateFailed;
                failureText = PrinterSetupMessages.Resolve(error);
                RecordTelemetry(PrinterActivatorTelemetry.QueueCreateFailed, queueName);
                return false;
            }

            if (!VerifyQueueCreated(queueName, usbPortName, out error, out failureText))
            {
                RecordTelemetry(PrinterActivatorTelemetry.QueueCreateFailed, queueName + " 回读不符");
                return false;
            }

            RecordTelemetry(PrinterActivatorTelemetry.QueueCreated, queueName);
            return true;
        }

        private static void RecordTelemetry(string kind, string detail)
        {
            Action<string, string> record = PrinterActivatorTelemetry.Record;
            if (record != null)
            {
                record(kind, detail);
            }
        }

        /// <summary>
        /// 建队列回读·纯判定（printui 同步返回后注册表键已就位，重试是纯保险）。
        /// 三项全对才算成功：队列键存在/驱动≈Generic / Text Only（归一化空格）/端口一致。
        /// </summary>
        /// <param name="queueExists">队列键是否存在。</param>
        /// <param name="driverValue">注册表驱动值。</param>
        /// <param name="portValue">注册表端口值。</param>
        /// <param name="expectedPort">期望端口。</param>
        /// <param name="error">失败分类码（成功=None）。</param>
        /// <param name="failureText">失败文案（成功=null）。</param>
        /// <returns>三项全对与否。</returns>
        public static bool VerifyCreatedCore(
            bool queueExists, string driverValue, string portValue, string expectedPort,
            out PrinterSetupError error, out string failureText)
        {
            error = PrinterSetupError.None;
            failureText = null;
            if (!queueExists)
            {
                error = PrinterSetupError.VerifyQueueMissing;
                failureText = PrinterSetupMessages.Resolve(error);
                return false;
            }

            if (!string.Equals(NormalizeDriverName(driverValue), "Generic / Text Only", StringComparison.Ordinal))
            {
                error = PrinterSetupError.VerifyDriverMismatch;
                failureText = PrinterSetupMessages.Resolve(error);
                return false;
            }

            if (!string.Equals((portValue ?? string.Empty).Trim(), (expectedPort ?? string.Empty).Trim(),
                StringComparison.OrdinalIgnoreCase))
            {
                error = PrinterSetupError.VerifyPortMismatch;
                failureText = PrinterSetupMessages.Resolve(error);
                return false;
            }

            return true;
        }

        /// <summary>驱动名归一（多空格并一、去尾空；printui 各 Windows 版本落值空格不一）。</summary>
        private static string NormalizeDriverName(string driver)
        {
            if (string.IsNullOrEmpty(driver))
            {
                return string.Empty;
            }

            return string.Join(" ", driver.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries));
        }

        /// <summary>建队列后回读（生产封装：5×400ms 轮读注册表；全对才认成功）。</summary>
        /// <param name="queueName">队列名。</param>
        /// <param name="usbPortName">期望端口。</param>
        /// <param name="error">失败分类码（成功=None）。</param>
        /// <param name="failureText">失败文案（成功=null）。</param>
        /// <returns>回读通过与否。</returns>
        public static bool VerifyQueueCreated(string queueName, string usbPortName,
            out PrinterSetupError error, out string failureText)
        {
            error = PrinterSetupError.None;
            failureText = null;
            for (int attempt = 0; attempt < 5; attempt++)
            {
                bool queueExists = QueueExists(queueName);
                string driver = queueExists ? TryGetQueueValue(queueName, "Printer Driver") : null;
                string port = queueExists ? TryGetQueueValue(queueName, "Port") : null;
                if (VerifyCreatedCore(queueExists, driver, port, usbPortName, out error, out failureText))
                {
                    return true;
                }

                if (attempt < 4)
                {
                    System.Threading.Thread.Sleep(400);   // 末次不再白睡
                }
            }

            return false;
        }

        /// <summary>
        /// 回读失败后的现状诊断（按当前注册表实况给最贴切的一条；读不到/异常=null
        /// 调用方回退通用文案。非 Windows 运行时 fail-open=返回 null）。
        /// </summary>
        /// <param name="instanceId">USB 实例全路径。</param>
        /// <param name="usbPortName">期望端口。</param>
        /// <returns>诊断文案（可 null）。</returns>
        public static string DescribeQueueFailure(string instanceId, string usbPortName)
        {
            try
            {
                string queueName = BuildQueueName(instanceId, usbPortName);
                bool exists = QueueExists(queueName);
                string driver = exists ? TryGetQueueValue(queueName, "Printer Driver") : null;
                string port = exists ? TryGetQueueValue(queueName, "Port") : null;
                PrinterSetupError error;
                string text;
                VerifyCreatedCore(exists, driver, port, usbPortName, out error, out text);
                return text;
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// printui 参数构造（可测缝；真机实证修复）：**进程直起禁 %windir%**——
        /// ProcessStartInfo.Arguments 不经 cmd，环境变量不展开，printui 收到字面量
        /// "%windir%\inf\ntprint.inf" 找不到 inf 必败（真机两轮失败根因；经 cmd 的
        /// 等价命令成功＝对照坐实）。inf 路径走 SpecialFolder.Windows 实展开。
        /// </summary>
        internal static string BuildPrintUiArgs(string queueName, string usbPortName)
        {
            string infPath = System.IO.Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.Windows), "inf", "ntprint.inf");
            return "/if /b \"" + queueName + "\" /f \"" + infPath + "\" /r \"" +
                usbPortName + "\" /m \"Generic / Text Only\"";
        }

        /// <summary>取队列注册表驱动名（读不到=null）。</summary>
        /// <param name="queueName">队列名。</param>
        /// <returns>驱动名。</returns>
        public static string TryGetQueueDriver(string queueName)
        {
            return TryGetQueueValue(queueName, "Printer Driver");
        }

        /// <summary>队列→端口反查（诊断串用：Printers\&lt;queue&gt; 的 Port 值；读不到=null）。</summary>
        /// <param name="queueName">队列名。</param>
        /// <returns>端口名。</returns>
        public static string TryGetQueuePort(string queueName)
        {
            return TryGetQueueValue(queueName, "Port");
        }

        /// <summary>队列注册表值反查单点（读失败/缺失=null，禁炸）。</summary>
        private static string TryGetQueueValue(string queueName, string valueName)
        {
            if (string.IsNullOrWhiteSpace(queueName))
            {
                return null;
            }

            try
            {
                using (RegistryKey printers = Registry.LocalMachine.OpenSubKey(
                    @"SYSTEM\CurrentControlSet\Control\Print\Printers"))
                {
                    if (printers == null)
                    {
                        return null;
                    }

                    foreach (string name in printers.GetSubKeyNames())
                    {
                        if (!string.Equals(name, queueName, StringComparison.OrdinalIgnoreCase))
                        {
                            continue;
                        }

                        using (RegistryKey printerKey = printers.OpenSubKey(name))
                        {
                            return printerKey != null ? printerKey.GetValue(valueName) as string : null;
                        }
                    }
                }
            }
            catch (Exception)
            {
                // 读失败=null（诊断/过滤缺字段不炸）。
            }

            return null;
        }

        /// <summary>起 rundll32 printui 进程（30s 收口；超时 kill 再拒；异常=false）。</summary>
        private static bool RunPrintUi(string arguments)
        {
            try
            {
                using (Process process = Process.Start(new ProcessStartInfo
                {
                    // 全路径防 CWD 劫持（提权语境下 CreateProcess 搜索序含当前目录）。
                    FileName = System.IO.Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.System), "rundll32.exe"),
                    Arguments = "printui.dll,PrintUIEntry " + arguments,
                    UseShellExecute = false,
                    CreateNoWindow = true
                }))
                {
                    if (process == null)
                    {
                        return false;
                    }

                    // WaitForExit(false 返回)=超时未退，此时读 ExitCode 会抛
                    // InvalidOperationException（进程仍活着）——必须先 kill 再拒。
                    if (!process.WaitForExit(30000))
                    {
                        try
                        {
                            process.Kill();
                        }
                        catch (Exception)
                        {
                            // kill 失败不遮蔽主判定（仍是失败=拒）。
                        }

                        return false;
                    }

                    return process.ExitCode == 0;
                }
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>
        /// 扫描选择（纯函数；测试缝）：从探测候选里选**首个待准备设备**——
        /// 端口不可读（空串，无法自动绑定）跳过；已就绪跳过。
        /// 返回 null＝无需提示（单提示槽位：一次只报一台，多台排队后续批）。
        /// </summary>
        /// <param name="devices">探测候选。</param>
        /// <param name="isReady">就绪判定（可 null=全部视为未就绪）。</param>
        /// <returns>待准备设备（可 null）。</returns>
        public static UsbPrinterDevice SelectPendingDevice(
            IList<UsbPrinterDevice> devices,
            Func<UsbPrinterDevice, bool> isReady)
        {
            if (devices == null)
            {
                return null;
            }

            foreach (UsbPrinterDevice device in devices)
            {
                if (device == null || string.IsNullOrEmpty(device.PortName))
                {
                    continue;
                }

                if (isReady != null && isReady(device))
                {
                    continue;
                }

                return device;
            }

            return null;
        }

        // ---------- 端口复用四态分类（只服务扫描/提示链，禁接出票路由——红线） ----------

        /// <summary>队列就绪四态。</summary>
        public enum QueueReadiness
        {
            /// <summary>自家确定性名队列在册——本机既往自建，直接就绪。</summary>
            OwnQueueReady = 0,

            /// <summary>端口被其它队列占用但模型匹配（归一化/长公共段双向命中）——
            /// 大概率同一台机照打，视为就绪。</summary>
            ForeignQueueCompatible = 1,

            /// <summary>端口被其它队列占用且模型对不上——嫌疑复用（温和提示；
            /// **不影响出票路由**）。</summary>
            ForeignQueueSuspect = 2,

            /// <summary>端口无任何队列绑定——全新待设置。</summary>
            PortIdle = 3
        }

        /// <summary>
        /// 模型 token 匹配（纯函数）：①归一化全串双向 contains（HPRT_TP582 vs
        /// HPRTTP582）；②**长公共段兜底**——归一化后字母数字连续段里存在 ≥4 字符的
        /// 公共段双向命中（LabelTP582 vs HPRT_TP582 → "tp582" 救回存量自建队列）。
        /// </summary>
        /// <param name="instanceModel">实例模型段。</param>
        /// <param name="queueName">队列名。</param>
        /// <returns>匹配与否。</returns>
        public static bool ModelTokensMatch(string instanceModel, string queueName)
        {
            string a = NormalizeToken(instanceModel);
            string b = NormalizeToken(queueName);
            if (a.Length == 0 || b.Length == 0)
            {
                return false;
            }

            if (a.IndexOf(b, StringComparison.Ordinal) >= 0 || b.IndexOf(a, StringComparison.Ordinal) >= 0)
            {
                return true;
            }

            // 长公共子串 ≥4（LabelTP582 vs HPRT_TP582 → "tp582"）；段互含在无分隔符
            // 机型串上退化为整串比对，改经典最长公共子串判定。
            return LongestCommonSubstring(a, b) >= 4;
        }

        /// <summary>token 归一：小写、去 _-空格点。</summary>
        private static string NormalizeToken(string text)
        {
            if (string.IsNullOrEmpty(text))
            {
                return string.Empty;
            }

            var builder = new System.Text.StringBuilder(text.Length);
            for (int i = 0; i < text.Length; i++)
            {
                char c = char.ToLowerInvariant(text[i]);
                if (c == '_' || c == '-' || c == ' ' || c == '.')
                {
                    continue;
                }

                builder.Append(c);
            }

            return builder.ToString();
        }

        /// <summary>最长公共子串长度（小写字母数字串；O(n·m) 规模=机型名，无所谓）。</summary>
        private static int LongestCommonSubstring(string a, string b)
        {
            if (string.IsNullOrEmpty(a) || string.IsNullOrEmpty(b))
            {
                return 0;
            }

            int best = 0;
            int[] previous = new int[b.Length + 1];
            int[] current = new int[b.Length + 1];
            for (int i = 1; i <= a.Length; i++)
            {
                for (int j = 1; j <= b.Length; j++)
                {
                    current[j] = a[i - 1] == b[j - 1] ? previous[j - 1] + 1 : 0;
                    if (current[j] > best)
                    {
                        best = current[j];
                    }
                }

                int[] swap = previous;
                previous = current;
                current = swap;
                Array.Clear(current, 0, current.Length);
            }

            return best;
        }

        /// <summary>四态分类·纯函数（单测注入注册表读面；生产薄封装 EvaluateQueueReady）。</summary>
        /// <param name="instanceId">实例全路径。</param>
        /// <param name="portName">端口名。</param>
        /// <param name="ownQueueExists">自家队列是否在册。</param>
        /// <param name="boundQueueName">绑定该端口的既有队列名（可 null）。</param>
        /// <returns>四态。</returns>
        public static QueueReadiness ClassifyQueueReadiness(
            string instanceId, string portName, bool ownQueueExists, string boundQueueName)
        {
            if (ownQueueExists)
            {
                return QueueReadiness.OwnQueueReady;
            }

            if (!string.IsNullOrWhiteSpace(portName) && !string.IsNullOrEmpty(boundQueueName))
            {
                string model = ExtractSegment(instanceId, 1);
                return ModelTokensMatch(model, boundQueueName)
                    ? QueueReadiness.ForeignQueueCompatible
                    : QueueReadiness.ForeignQueueSuspect;
            }

            return QueueReadiness.PortIdle;
        }

        /// <summary>四态评估·生产封装（注册表读；异常 fail-open=OwnQueueReady，禁因探测失败打扰）。</summary>
        /// <param name="instanceId">实例全路径。</param>
        /// <param name="usbPortName">端口名。</param>
        /// <returns>四态。</returns>
        public static QueueReadiness EvaluateQueueReady(string instanceId, string usbPortName)
        {
            try
            {
                string ownQueue = BuildQueueName(instanceId, usbPortName);
                bool ownExists = QueueExists(ownQueue);
                string bound = ownExists ? null : FindQueueBoundToPort(usbPortName);
                return ClassifyQueueReadiness(instanceId, usbPortName, ownExists, bound);
            }
            catch (Exception)
            {
                return QueueReadiness.OwnQueueReady;
            }
        }

        /// <summary>绑定指定端口的队列名（第一个命中；无=null）。生产给 EvaluateQueueReady，诊断包复用。</summary>
        /// <param name="usbPortName">端口名。</param>
        /// <returns>队列名（可 null）。</returns>
        public static string FindQueueBoundToPort(string usbPortName)
        {
            if (string.IsNullOrWhiteSpace(usbPortName))
            {
                return null;
            }

            try
            {
                using (RegistryKey printers = Registry.LocalMachine.OpenSubKey(
                    @"SYSTEM\CurrentControlSet\Control\Print\Printers"))
                {
                    if (printers == null)
                    {
                        return null;
                    }

                    foreach (string name in printers.GetSubKeyNames())
                    {
                        using (RegistryKey printerKey = printers.OpenSubKey(name))
                        {
                            if (printerKey == null)
                            {
                                continue;
                            }

                            string port = printerKey.GetValue("Port") as string;
                            if (string.Equals(port, usbPortName, StringComparison.OrdinalIgnoreCase))
                            {
                                return name;
                            }
                        }
                    }
                }
            }
            catch (Exception)
            {
                return null;
            }

            return null;
        }

        /// <summary>
        /// 扫描分类·多台版（生产入口）：待设置集＋嫌疑标志就地写入 DTO（VM 只透传）。
        /// 遥测**不在本层记**（嫌疑机常驻时轮询会把计数器与事件环刷穿——去抖归
        /// 宿主扫描服务按嫌疑集指纹判定）；boundQueueLookup/occupantDriverLookup
        /// 供测试注入（非 Windows 运行时无注册表）。
        /// </summary>
        /// <param name="devices">探测候选。</param>
        /// <param name="evaluate">就绪评估（可 null=生产注册表读）。</param>
        /// <param name="boundQueueLookup">端口→占口队列名注入缝。</param>
        /// <param name="occupantDriverLookup">队列→驱动名注入缝。</param>
        /// <returns>待设置集。</returns>
        public static IList<UsbPrinterDevice> ClassifyPendingDevices(
            IList<UsbPrinterDevice> devices,
            Func<UsbPrinterDevice, QueueReadiness> evaluate,
            Func<string, string> boundQueueLookup = null,
            Func<string, string> occupantDriverLookup = null)
        {
            var pending = new List<UsbPrinterDevice>();
            if (devices == null)
            {
                return pending;
            }

            foreach (UsbPrinterDevice device in devices)
            {
                if (device == null || string.IsNullOrEmpty(device.PortName))
                {
                    continue;
                }

                QueueReadiness readiness = evaluate != null
                    ? evaluate(device)
                    : EvaluateQueueReady(device.InstanceId, device.PortName);
                if (readiness == QueueReadiness.OwnQueueReady || readiness == QueueReadiness.ForeignQueueCompatible)
                {
                    continue;
                }

                if (readiness == QueueReadiness.ForeignQueueSuspect)
                {
                    device.SuspectPortReuse = true;
                    Func<string, string> lookup = boundQueueLookup ?? FindQueueBoundToPort;
                    string occupant = lookup(device.PortName) ?? string.Empty;
                    device.ReuseQueueName = occupant;
                    // 占口队列装的是厂商驱动（多为针式/A4 单据机）——热敏指令进针式=
                    // 乱码纸，提示应指路设置模块而非给试打按钮。驱动读不到=不设
                    //（fail-open 原行为）。
                    if (occupant.Length > 0)
                    {
                        Func<string, string> driverLookup = occupantDriverLookup ?? TryGetQueueDriver;
                        string occupantDriver = driverLookup(occupant);
                        if (!string.IsNullOrEmpty(occupantDriver)
                            && occupantDriver.IndexOf("Text Only", StringComparison.OrdinalIgnoreCase) < 0)
                        {
                            device.VendorDriverPort = true;
                        }
                    }
                }

                pending.Add(device);
            }

            return pending;
        }

        /// <summary>本机队列清单（诊断包用；name/driver/port 三列；读失败跳过该项）。</summary>
        /// <returns>队列行集。</returns>
        public static IList<QueueRowInfo> EnumerateQueues()
        {
            var rows = new List<QueueRowInfo>();
            try
            {
                using (RegistryKey printers = Registry.LocalMachine.OpenSubKey(
                    @"SYSTEM\CurrentControlSet\Control\Print\Printers"))
                {
                    if (printers == null)
                    {
                        return rows;
                    }

                    foreach (string name in printers.GetSubKeyNames())
                    {
                        using (RegistryKey printerKey = printers.OpenSubKey(name))
                        {
                            if (printerKey == null)
                            {
                                continue;
                            }

                            rows.Add(new QueueRowInfo
                            {
                                Name = name,
                                Driver = printerKey.GetValue("Printer Driver") as string,
                                Port = printerKey.GetValue("Port") as string
                            });
                        }
                    }
                }
            }
            catch (Exception)
            {
                // 读失败=返回已收部分（诊断包如实呈现）。
            }

            return rows;
        }

        /// <summary>队列清单行（诊断包导出面）。</summary>
        public sealed class QueueRowInfo
        {
            /// <summary>队列名。</summary>
            public string Name { get; set; }

            /// <summary>驱动名。</summary>
            public string Driver { get; set; }

            /// <summary>端口名。</summary>
            public string Port { get; set; }
        }

        /// <summary>队列存在性（Spooler 队列表查名——注册表 Printers 键枚举，大小写不敏感）。</summary>
        private static bool QueueExists(string queueName)
        {
            using (RegistryKey key = Registry.LocalMachine.OpenSubKey(
                @"SYSTEM\CurrentControlSet\Control\Print\Printers"))
            {
                if (key == null)
                {
                    return false;
                }

                foreach (string name in key.GetSubKeyNames())
                {
                    if (string.Equals(name, queueName, StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        /// <summary>
        /// 队列脱机判定：注册表 Printers\&lt;name&gt;\Attributes 的
        /// PRINTER_ATTRIBUTE_WORK_OFFLINE(0x400) 位。读不到/异常=fail-open 在线
        /// （探测失败不得误伤正常发作业——脱机拦截只在确证时生效）。
        /// </summary>
        /// <param name="queueName">队列名。</param>
        /// <returns>在线与否（读不到=在线）。</returns>
        public static bool IsQueueOnline(string queueName)
        {
            if (string.IsNullOrWhiteSpace(queueName))
            {
                return true;
            }

            try
            {
                using (RegistryKey key = Registry.LocalMachine.OpenSubKey(
                    @"SYSTEM\CurrentControlSet\Control\Print\Printers\" + queueName.Trim()))
                {
                    if (key == null)
                    {
                        return true;   // 队列不存在走既有存在性判定，这里只管脱机位
                    }

                    object raw = key.GetValue("Attributes");
                    if (raw is int)
                    {
                        return ((int)raw & 0x400) == 0;
                    }

                    return true;
                }
            }
            catch (Exception)
            {
                return true;
            }
        }

        /// <summary>队列注册在册与否（公共判定：设置面与出票路由共用同一判定；
        /// 用「键存在」而非「驱动值可读」——驱动值缺失的合法队列不得被判死。
        /// 读注册表异常=fail-open true（探测失败不降级设备可用性））。</summary>
        /// <param name="queueName">队列名。</param>
        /// <returns>在册与否。</returns>
        public static bool IsQueueRegistered(string queueName)
        {
            if (string.IsNullOrWhiteSpace(queueName))
            {
                return false;
            }

            try
            {
                return QueueExists(queueName.Trim());
            }
            catch (Exception)
            {
                return true;
            }
        }
    }
}
