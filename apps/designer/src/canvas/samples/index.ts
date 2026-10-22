// SPDX-License-Identifier: Apache-2.0
// 样例模板注册表（后端 API 未接入前的本地数据源；接入后由 shared/api.ts 替换）。
import { couponSheetTemplate } from './coupon-sheet';
import { inventoryReportTemplate } from './inventory-report';
import { sampleTemplate } from './sales-note';
import type { TemplateLike } from '../store';

export interface SampleEntry {
  id: string;
  label: string;
  template: TemplateLike;
}

export const sampleRegistry: SampleEntry[] = [
  { id: 'sales-note', label: '销售单（v1.0 → 自动迁移）', template: sampleTemplate },
  {
    id: 'inventory-report',
    label: '盘点汇总表（v2.0 中国式报表）',
    template: inventoryReportTemplate,
  },
  { id: 'coupon-sheet', label: '代金券联页（v2.0 一页多单）', template: couponSheetTemplate },
];
