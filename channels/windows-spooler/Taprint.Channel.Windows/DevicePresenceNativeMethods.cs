// SPDX-License-Identifier: Apache-2.0
#nullable disable
using System.Runtime.InteropServices;

namespace Taprint.Channel.Windows
{
    /// <summary>
    /// cfgmgr32 设备在位判定 P/Invoke（按域拆分自上游单文件 NativeMethods；
    /// UsbPrinterProbe 用）。Windows 保留拔除设备的历史实例键（幽灵实例），
    /// 不做在位过滤会把幽灵当新打印机弹提示。
    /// 来源=Microsoft Docs「CM_Locate_DevNode」CFGMGR32.h。
    /// </summary>
    internal static class DevicePresenceNativeMethods
    {
        private const string CfgMgrDll = "cfgmgr32.dll";

        /// <summary>CM_* 成功码。</summary>
        public const int CR_SUCCESS = 0x00000000;

        /// <summary>设备节点已启动位（cmutil.h DN_STARTED——停用/未启动设备不置位）。</summary>
        public const uint DN_STARTED = 0x00000008;

        /// <summary>
        /// 按设备实例 ID 定位设备节点。ulFlags=0（CM_LOCATE_DEVNODE_NORMAL）
        /// **只找在位设备**，幽灵（已拔除）返回 CR_NO_SUCH_DEVNODE 等非零——
        /// 这正是幽灵过滤判据。
        /// </summary>
        [DllImport(CfgMgrDll, CharSet = CharSet.Unicode)]
        public static extern int CM_Locate_DevNodeW(out uint pdnDevInst, string pDeviceID, uint ulFlags);

        /// <summary>取设备节点状态（pulStatus 含 DN_STARTED 等位；返回 CR_SUCCESS=0 为成功）。</summary>
        [DllImport(CfgMgrDll)]
        public static extern int CM_Get_DevNode_Status(out uint pulStatus, out uint pulProblemNumber, uint dnDevInst, uint ulFlags);
    }
}
