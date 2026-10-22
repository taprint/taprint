// SPDX-License-Identifier: Apache-2.0
#nullable disable
using System;
using System.Collections.Generic;
using Microsoft.Win32;

namespace Taprint.Channel.Windows
{
    /// <summary>
    /// USB 打印设备注册表探测。
    ///
    /// 枚举 HKLM\SYSTEM\CurrentControlSet\Enum\USBPRINT（Windows USB 打印类设备
    /// 注册表键，每台 USB 打印机一条实例键，键名＝USBPRINT\VID_型号\序号）——
    /// 毫秒级纯注册表读，禁 WMI（Win32_PnPEntity 冷枚举 1–5s+ 且 Discover 为同步
    /// 调用，卡页风险）。
    ///
    /// 在位过滤：Windows 会保留已拔除设备的历史实例键（幽灵实例，含
    /// Device Parameters\PortName 残留）——不做在位判定会把幽灵当新打印机弹提示、
    /// 且可能遮蔽真实新设备。判据＝CM_Locate_DevNodeW(NORMAL) 可定位 且 节点含
    /// DN_STARTED（见 IsDevicePresent；判定异常＝放行，禁误杀真设备）。
    ///
    /// 每台出一条候选：InstanceId=全实例路径（稳定键——端口号会随重启重排，MS 官方
    /// 口径）、DisplayName=友好名（@资源引用形取分号后文本，再回退型号段——
    /// DeviceDesc 常为 INF 资源引用，禁原样摆给使用者）、PortName=USB00x
    /// （Device Parameters 子键读，缺失=空串由调用方降级不弹）。
    ///
    /// 失败口径：注册表不可达/键缺失 ⇒ 空表；**枚举中途异常 ⇒ 返回已收集部分列表**
    /// （真实行为是部分列表而非空表），不抛。
    /// </summary>
    public static class UsbPrinterProbe
    {
        private const string UsbPrintEnumKey = @"SYSTEM\CurrentControlSet\Enum\USBPRINT";

        /// <summary>在位判定缝（默认＝CM 实判定；测试/诊断注入用。
        /// 返回 false＝过滤该实例）。</summary>
        internal static Func<string, bool> DevicePresentCheck = IsDevicePresent;

        /// <summary>枚举 USB 打印类设备实例（0 台=无 USB 打印机在位；异常降级空表/部分表）。</summary>
        /// <returns>候选集。</returns>
        public static IList<UsbPrinterDevice> Probe()
        {
            List<UsbPrinterDevice> found = new List<UsbPrinterDevice>();
            try
            {
                using (RegistryKey enumKey = Registry.LocalMachine.OpenSubKey(UsbPrintEnumKey))
                {
                    if (enumKey == null)
                    {
                        return found;
                    }

                    foreach (string deviceKeyPath in enumKey.GetSubKeyNames())
                    {
                        // 两层键：USBPRINT\<型号>\<实例序号>（winpool 枚举布局）。
                        using (RegistryKey modelKey = enumKey.OpenSubKey(deviceKeyPath))
                        {
                            if (modelKey == null)
                            {
                                continue;
                            }

                            foreach (string instanceId in modelKey.GetSubKeyNames())
                            {
                                using (RegistryKey instanceKey = modelKey.OpenSubKey(instanceId))
                                {
                                    if (instanceKey == null)
                                    {
                                        continue;
                                    }

                                    string fullPath = "USBPRINT\\" + deviceKeyPath + "\\" + instanceId;
                                    if (!DevicePresentCheck(fullPath))
                                    {
                                        continue;   // 幽灵/停用实例：不列候选
                                    }

                                    string friendly = ResolveDisplayName(instanceKey, deviceKeyPath);
                                    // 端口名不在实例键根上，在 Device Parameters 子键
                                    //（USB 打印类设备驱动参数落地处；直读根键恒得空串）。
                                    // 读不到=空串由调用方降级（该设备不弹提示，禁绑不存在的端口）。
                                    string port = string.Empty;
                                    using (RegistryKey deviceParams = instanceKey.OpenSubKey("Device Parameters"))
                                    {
                                        if (deviceParams != null)
                                        {
                                            port = deviceParams.GetValue("PortName") as string ?? string.Empty;
                                        }
                                    }

                                    found.Add(new UsbPrinterDevice(
                                        instanceId: fullPath,
                                        friendlyName: friendly,
                                        portName: port));
                                }
                            }
                        }
                    }
                }
            }
            catch (Exception)
            {
                // 注册表不可达/权限受限＝探测降级已收集部分表（禁因探测失败影响业务面）。
            }

            return found;
        }

        /// <summary>
        /// 显示名解析：友好名 → DeviceDesc → **型号段**（父键名如 HPRTTP582）。
        /// INF 资源引用形（"@usbprint.inf,%xxx%;USB Printing Support"）取分号后文本；
        /// 仍不可读（纯引用无回退文本）⇒ 型号段。禁把内部实例路径摆给使用者。
        /// </summary>
        private static string ResolveDisplayName(RegistryKey instanceKey, string modelName)
        {
            string raw = instanceKey.GetValue("FriendlyName") as string;
            if (string.IsNullOrWhiteSpace(raw))
            {
                raw = instanceKey.GetValue("DeviceDesc") as string;
            }

            if (!string.IsNullOrWhiteSpace(raw))
            {
                string candidate = raw.Trim();
                if (candidate[0] == '@')
                {
                    int semicolon = candidate.LastIndexOf(';');
                    candidate = semicolon >= 0 ? candidate.Substring(semicolon + 1).Trim() : string.Empty;
                }

                if (candidate.Length > 0 && candidate[0] != '@')
                {
                    return candidate;
                }
            }

            return modelName ?? string.Empty;
        }

        /// <summary>
        /// 设备在位于否（幽灵实例过滤）。CM_LOCATE_DEVNODE_NORMAL 只找在位设备
        /// （幽灵/已拔除返回非 CR_SUCCESS）；再验 DN_STARTED（停用设备不置位——
        /// 也不该弹）。判定器本身异常＝放行（true）：宁可多提示一台幽灵，禁误杀
        /// 真设备（代价不对称）。
        /// </summary>
        private static bool IsDevicePresent(string instanceId)
        {
            try
            {
                uint devInst;
                if (DevicePresenceNativeMethods.CM_Locate_DevNodeW(out devInst, instanceId, 0) != DevicePresenceNativeMethods.CR_SUCCESS)
                {
                    return false;
                }

                uint status;
                uint problem;
                if (DevicePresenceNativeMethods.CM_Get_DevNode_Status(out status, out problem, devInst, 0) != DevicePresenceNativeMethods.CR_SUCCESS)
                {
                    return false;
                }

                return (status & DevicePresenceNativeMethods.DN_STARTED) != 0;
            }
            catch (Exception)
            {
                return true;   // 判定不可用＝保守放行（禁误杀）
            }
        }
    }

    /// <summary>USB 打印机候选（探测产物；InstanceId＝全实例路径＝稳定绑定键）。</summary>
    public sealed class UsbPrinterDevice
    {
        /// <summary>全实例路径（USBPRINT\型号\序号——稳定键，USB00x 重排免疫）。</summary>
        public string InstanceId { get; }

        /// <summary>显示名（友好名/资源引用回退文本/型号段——探测层已保可读）。</summary>
        public string FriendlyName { get; }

        /// <summary>端口名（USB00x 等；缺失=空串）。</summary>
        public string PortName { get; }

        /// <summary>
        /// 端口复用嫌疑（该口被其它**不同型号**队列占用——只由扫描链
        /// <see cref="PrinterActivator.ClassifyPendingDevices"/> 填充，VM 只透传）。
        /// 运行时标志，不参与任何持久化。
        /// </summary>
        public bool SuspectPortReuse { get; set; }

        /// <summary>嫌疑时占该口的既有队列名（温和提示用；空=未知）。</summary>
        public string ReuseQueueName { get; set; }

        /// <summary>
        /// 占用本口的队列装的是厂商驱动（非 Text Only——多为针式/A4 单据机）。
        /// 这类设备不给「试打小票/价签」（热敏指令进针式=乱码纸），改为指路设置模块。
        /// 只由扫描链填充，不持久化。
        /// </summary>
        public bool VendorDriverPort { get; set; }

        /// <summary>构造。</summary>
        /// <param name="instanceId">全实例路径。</param>
        /// <param name="friendlyName">显示名。</param>
        /// <param name="portName">端口名。</param>
        public UsbPrinterDevice(string instanceId, string friendlyName, string portName)
        {
            InstanceId = instanceId ?? string.Empty;
            FriendlyName = friendlyName ?? string.Empty;
            PortName = portName ?? string.Empty;
        }
    }
}
