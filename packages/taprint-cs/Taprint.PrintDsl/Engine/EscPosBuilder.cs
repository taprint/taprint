// SPDX-License-Identifier: Apache-2.0
#nullable disable
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Taprint.PrintDsl.Engine
{
    /// <summary>
    /// ESC/POS 字节构造器纯函数类：初始化/换行走纸/切纸/钱箱脉冲/中文编码选择——
    /// 每个命令常量注释字节出处；全部无副作用可单测（十六进制序列冻结断言），不碰传输。
    ///
    /// 依据口径：ESC/POS 命令集为 Epson TM 系列公开指令规范，被各兼容芯小票打印机
    /// （Goojprt/Xprinter/芯烨等国产主流）广泛复刻——cmd 常量的字节序列按业界通用子集冻结；
    /// 具体型号对个别命令的兼容差异属真机活体窗口核验项（未核验处以注释逐条登记）。
    /// （上游参照：仓库 ADR「协议名内嵌」与 CPCL/TSPL 构造器同族纪律。）
    /// </summary>
    public static class EscPosBuilder
    {
        /// <summary>ESC 控制字节 0x1B（规范通用前缀）。</summary>
        public const byte Esc = 0x1B;

        /// <summary>GS 控制字节 0x1D（组控制前缀）。</summary>
        public const byte Gs = 0x1D;

        /// <summary>
        /// 初始化打印机 ESC @（0x1B 0x40）：清打印缓冲、模式复位到上电默认。
        /// 出处=ESC/POS 指令规范「Initialize printer」。试打/出票首行前置。
        /// </summary>
        public static byte[] Initialize()
        {
            return new byte[] { Esc, 0x40 };
        }

        /// <summary>
        /// 换行走纸 LF（0x0A）：按当前行高走一行。文本须自带换行时用本命令收尾；
        /// 出票尾部建议配合 FeedLines 走多行把内容推出切纸口。
        /// </summary>
        public static byte[] LineFeed()
        {
            return new byte[] { 0x0A };
        }

        /// <summary>
        /// 走纸 n 行 ESC d n（0x1B 0x64 n）。出处=ESC/POS「Print and feed n lines」。
        /// </summary>
        public static byte[] FeedLines(byte lineCount)
        {
            return new byte[] { Esc, 0x64, lineCount };
        }

        /// <summary>
        /// 半切纸 GS V m（0x1D 0x56 0x42 0x00）——m=66/0x42 变体带第二参数 0，
        /// 是带自动切刀机型上最通用的「走纸到位后半切」形态；
        /// 无切刀机型多数静默忽略或仅走纸（真机差异=未核验登记项）。
        /// </summary>
        public static byte[] CutPaper()
        {
            return new byte[] { Gs, 0x56, 0x42, 0x00 };
        }

        /// <summary>
        /// 钱箱脉冲 ESC p m t1 t2（0x1B 0x70 m t1 t2）：通过打印机 RJ11 口弹开钱箱（主流形态）。
        /// 出处=ESC/POS「Generate pulse」：m∈{0,1} 选引脚（0=引脚2，1=引脚5——RJ11 六线中的
        /// 两根可编程线），t1=接通时长单位 ms 的近似刻度（芯片按 t1*2ms 归一刻度输出），t2=释放时刻度。
        /// </summary>
        public static byte[] DrawerKickPulse(byte pin, byte onTicks, byte offTicks)
        {
            if (pin != 0 && pin != 1)
            {
                throw new ArgumentOutOfRangeException("pin", pin, "钱箱脉冲引脚只允许 0(引脚2)/1(引脚5) 两值。");
            }

            return new byte[] { Esc, 0x70, pin, onTicks, offTicks };
        }

        /// <summary>钱箱脉冲便捷档：引脚 2，接通约 50ms/释放约 500ms（默认经验档，真机核验可调）。</summary>
        public static byte[] DrawerKickPulseDefault()
        {
            // t1=25 → 约 25×2ms=50ms 接通；t2=250 → 释放间隔占位（多数芯只在 on 边沿触发弹开）。
            return DrawerKickPulse(0, 25, 250);
        }

        /// <summary>
        /// 选择中文编码 FS &amp;（0x1C 0x26）。
        /// 中文票面以 GBK/GB18030 字节流写入是国产芯最普遍兼容路径；引擎统一 GB18030 超集
        /// 编码落字节，本构造器只负责「选中卡集」前缀字节（FS &amp;＝选择中文字符集）。
        /// 出处=ESC/POS 中文扩展指令（FS 系列）通行实现。
        /// </summary>
        public static byte[] SelectChineseEncoding()
        {
            return new byte[] { 0x1C, 0x26 };
        }

        /// <summary>
        /// 把 UTF-16 文本按指定代码页转为送打字节（中文票面主用 936=GBK / 54936=GB18030；
        /// 构造为独立纯函数以便单测冻结字节形状）。输入 null 视为空串。
        /// 运行时纪律：非内置代码页需要 System.Text.Encoding.CodePages 的提供程序注册
        /// （引擎构造面已注册；未注册环境下本方法抛 InvalidOperationException，错误信息
        /// 直接指向注册缺口而非静默降级）。
        /// </summary>
        public static byte[] EncodeText(string text, int codePage)
        {
            try
            {
                Encoding encoding = Encoding.GetEncoding(codePage);
                return encoding.GetBytes(text ?? string.Empty);
            }
            catch (NotSupportedException ex)
            {
                throw new InvalidOperationException(
                    "代码页 " + codePage.ToString(CultureInfo.InvariantCulture) +
                    " 不可用：需先注册 System.Text.Encoding.CodePages 提供程序。", ex);
            }
        }

        /// <summary>ASCII 文本转码便捷面（内置零依赖；试打标识行等西文场景专用）。</summary>
        public static byte[] EncodeAscii(string text)
        {
            return Encoding.ASCII.GetBytes(text ?? string.Empty);
        }

        /// <summary>
        /// 组装一帧最小自检测试票字节（试打用）：初始化 + 标识行 + 三次走纸 + 半切。
        /// 纯函数拼接，单测断言首尾帧标记即可。刻意保持纯 ASCII：消除对
        /// 代码页提供程序的运行时依赖，真机中文票面归出票引擎。
        /// </summary>
        public static byte[] BuildSelfTestReceipt()
        {
            List<byte> frame = new List<byte>();
            frame.AddRange(Initialize());
            frame.AddRange(EncodeAscii("TAPRINT PRINT SELFTEST"));
            frame.AddRange(LineFeed());
            frame.AddRange(FeedLines(3));
            frame.AddRange(CutPaper());
            return frame.ToArray();
        }

        /// <summary>字节序十六进制串化（大写、空格分隔；单测冻结用诊断辅助，非送打路径）。</summary>
        public static string ToHex(byte[] bytes)
        {
            if (bytes == null)
            {
                return string.Empty;
            }

            StringBuilder builder = new StringBuilder(bytes.Length * 3);
            for (int i = 0; i < bytes.Length; i++)
            {
                if (i > 0)
                {
                    builder.Append(' ');
                }

                builder.Append(bytes[i].ToString("X2", CultureInfo.InvariantCulture));
            }

            return builder.ToString();
        }
    }
}
