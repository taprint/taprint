// SPDX-License-Identifier: Apache-2.0
// netstandard2.0 无 IsExternalInit（C# 9 record/init 访问器编译所需），此处 polyfill。
namespace System.Runtime.CompilerServices
{
    internal static class IsExternalInit
    {
    }
}
