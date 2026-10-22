// SPDX-License-Identifier: Apache-2.0
#nullable disable
using System;

namespace Taprint.PrintDsl.Engine
{
    /// <summary>
    /// 引擎内核日志抽象：内核零依赖纪律下替代宿主日志框架——
    /// 宿主以 <c>Action&lt;string&gt;</c> 委托注入（Warn/Error 两面），未注入＝静默
    /// （默认 <see cref="Silent"/>，打印主链不受日志面影响）。
    /// 引擎只在「跳过不可映射元素/丢弃越界元素/遇到未知 IR 行」这类可继续运行的
    /// 降级点发 Warn；Error 面预留给宿主接管的致命路径（内核自身不炸不记）。
    /// </summary>
    public sealed class EngineLog
    {
        /// <summary>静默单例（默认：所有消息丢弃）。</summary>
        public static readonly EngineLog Silent = new EngineLog(null, null);

        private readonly Action<string> _warn;
        private readonly Action<string> _error;

        /// <summary>
        /// 构造（两面皆可 null——对应面静默；全 null 等价 <see cref="Silent"/>）。
        /// </summary>
        /// <param name="warn">警告面委托（可继续运行的降级事件）。</param>
        /// <param name="error">错误面委托（宿主判定的致命事件）。</param>
        public EngineLog(Action<string> warn, Action<string> error)
        {
            _warn = warn;
            _error = error;
        }

        /// <summary>发一条警告（委托未注入＝静默丢弃，禁抛）。</summary>
        public void Warn(string message)
        {
            _warn?.Invoke(message ?? string.Empty);
        }

        /// <summary>发一条错误（委托未注入＝静默丢弃，禁抛）。</summary>
        public void Error(string message)
        {
            _error?.Invoke(message ?? string.Empty);
        }
    }
}
