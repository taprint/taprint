// SPDX-License-Identifier: Apache-2.0
// 样例模板：直接引用跨端共享 fixture（fixtures/templates/sales-note-v1.0.json， 锁定物）——
// 后端 API 未接入前的本地数据源；接入后由 shared/api.ts 加载真实模板替换。
// 依赖声明：该引用在构建时被内联进产物，属 monorepo 内隐式依赖；designer-web
// 是不发布的独立 SPA（整仓部署），无 npm publish 漏文件风险，故不入 package.json。
import salesNoteJson from '../../../samples/sales-note-v1.0.json';
import type { TemplateLike } from '../store';

export const sampleTemplate = salesNoteJson as unknown as TemplateLike;
