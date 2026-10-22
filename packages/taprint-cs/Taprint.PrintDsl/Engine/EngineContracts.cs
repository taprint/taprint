// SPDX-License-Identifier: Apache-2.0
#nullable disable
using System;

namespace Taprint.PrintDsl.Engine
{
    /// <summary>
    /// 打印域类型化异常：错码 8400-8499 段（内核仅承载引擎面实际用到的子集，
    /// 见 <see cref="PrintErrorCode"/> 与 <see cref="LabelPrintErrorCode"/> 台账注释）。
    /// 调用方按 <see cref="Code"/> 分诊，禁裸 IOException/InvalidOperationException 上串业务层。
    /// </summary>
    public class PrintDomainException : Exception
    {
        /// <summary>打印域内部错码（PrintErrorCode 常量面唯一事实源）。</summary>
        public int Code { get; private set; }

        /// <summary>构造（无内因形态）。</summary>
        /// <param name="code">错码（台账常量）。</param>
        /// <param name="message">人读消息。</param>
        public PrintDomainException(int code, string message)
            : base(message)
        {
            Code = code;
        }

        /// <summary>构造（带内因）。</summary>
        /// <param name="code">错码（台账常量）。</param>
        /// <param name="message">人读消息。</param>
        /// <param name="inner">内因异常。</param>
        public PrintDomainException(int code, string message, Exception inner)
            : base(message, inner)
        {
            Code = code;
        }
    }

    /// <summary>
    /// 打印域错码台账（8400-8499 段）：业务代码只许引用本类常量，段位数字
    /// 不出现在第二处。此处收录引擎内核实际使用的条目（票据域）。
    /// </summary>
    public static class PrintErrorCode
    {
        /// <summary>print_dsl 解析失败（元素树形态非法）。</summary>
        public const int DslParseFailed = 8404;

        /// <summary>出票引擎中文编码提供程序不可用（CodePages 注册失败）。</summary>
        public const int EncodingUnavailable = 8405;
    }

    /// <summary>
    /// 标签面错码台账（票据域 8400-8405 之后顺延 8408 起；标签面常量唯一事实源在本类）。
    /// </summary>
    public static class LabelPrintErrorCode
    {
        /// <summary>模板无 label 呈现（label 呈现 JSON 空——显式报错禁静默空打）。</summary>
        public const int LabelPresentationMissing = 8408;

        /// <summary>label 呈现 JSON 畸形（size/body/x/y/type/content 必填面契约违约）。</summary>
        public const int LabelIrMalformed = 8409;

        /// <summary>打印机通道不可得（无该打印机标识的可用通道——行级失败统一码）。</summary>
        public const int LabelChannelUnavailable = 8410;
    }
}
