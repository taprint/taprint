// SPDX-License-Identifier: Apache-2.0
// monaco worker 接线（DR14：monaco × Vite 7 的 ?worker 构建验证点）。
// 自定义 monarch 语言只需 editor 核心 worker（文本模型基础能力），不挂
// ts/json/css/html 语言 worker——表达式语言不是 TS 方言，语法错误走
// 内核 ExpressionCompiler 诊断而非 monaco 语言服务。
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

let installed = false;

export function installMonacoWorkers(): void {
  if (installed) return;
  installed = true;
  (self as unknown as { MonacoEnvironment: object }).MonacoEnvironment = {
    getWorker(): Worker {
      return new EditorWorker();
    },
  };
}
