// SPDX-License-Identifier: Apache-2.0
// 样例模板：中国式报表 fixture（fixtures/templates/inventory-report-v2.0.json， 锚点物）——
// 9 项 v2 能力全覆盖（多级/斜线表头、合并、分组小计、主从子表、staticRows、水印、
// 跨页表头、loop/conditional）；加载链路同 sales-note.ts 口径。
import inventoryReportJson from '../../../samples/inventory-report-v2.0.json';
import type { TemplateLike } from '../store';

export const inventoryReportTemplate = inventoryReportJson as unknown as TemplateLike;
