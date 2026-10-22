// SPDX-License-Identifier: Apache-2.0
// 模板域数据层：seed 数据源。
// 持久化形态：内存 mock（页面刷新重置——后端 API 就绪后切换 HTTP 实现）。
//
// 三个样例模板（与 canvas/samples/index.ts 同源；sampleRegistry 形状冻结——模板 API 契约，
// 仅服务样例下拉，与 Repository 数字 id 是两套命名空间）作为 Repository id 1/2/3 注入：
// id=1 sales-note（销售单，v1.0 fixture，加载时 store 自动迁移至 2.0）
// id=2 inventory-report（盘点汇总表，v2.0 fixture）
// id=3 coupon-sheet（代金券联页，v2.0 fixture）
//
// 预置血缘：coupon-sheet (id=3) 标记为 sales-note (id=1) 的副本（sourceTemplateId=1）。
// 预置版本历史：sales-note (id=1) 一条 v1 published 版本（currentVersion=1，dsl=迁移后快照）。
import { DslParser } from 'taprint';
import { couponSheetTemplate } from '../canvas/samples/coupon-sheet';
import { inventoryReportTemplate } from '../canvas/samples/inventory-report';
import { sampleTemplate } from '../canvas/samples/sales-note';
import type { TemplateRecord } from './repository';
import type { TemplateVersion } from './types';

const NOW = Date.UTC(2026, 7, 9, 0, 0, 0); // 2026-08-09 00:00:00 UTC（与项目 TZ=UTC 一致；seed 确定性时间）

/**
 * 默认种子模板（Repository id 1/2/3，对齐后端 Long 主键形态）。
 * dsl 深拷贝自 sampleRegistry 模板内容（sampleRegistry 形状与内容冻结）。
 */
export function buildSeedTemplates(): TemplateRecord[] {
  return [
    {
      id: 1,
      name: '销售单',
      description: '门店销售小票默认模板（v1.0 fixture，加载时自动迁移至 2.0）',
      deviceClass: 'receipt',
      sourceTemplateId: null,
      sourceVersion: null,
      currentVersion: 1, // 预置一条版本历史（见 buildSeedVersions）
      status: 'published',
      dslSchemaVersion: String(sampleTemplate.schemaVersion ?? 'unknown'),
      createdAt: NOW,
      updatedAt: NOW,
      dsl: clone(sampleTemplate),
    },
    {
      id: 2,
      name: '盘点汇总表',
      description: '中国式报表：多级表头 + 分组小计 + 主从子表（v2.0 fixture）',
      deviceClass: 'doc',
      sourceTemplateId: null,
      sourceVersion: null,
      currentVersion: null,
      status: 'draft',
      dslSchemaVersion: String(inventoryReportTemplate.schemaVersion ?? 'unknown'),
      createdAt: NOW,
      updatedAt: NOW,
      dsl: clone(inventoryReportTemplate),
    },
    {
      id: 3,
      name: '代金券联页-副本',
      description: '一页多单 2×2 + 图片水印（v2.0 fixture）；预置血缘：来自「销售单」副本',
      deviceClass: 'doc',
      // 预置血缘：副本来自销售单 (id=1)，源版本号=销售单当前 currentVersion=1
      sourceTemplateId: 1,
      sourceVersion: 1,
      currentVersion: null,
      status: 'draft',
      dslSchemaVersion: String(couponSheetTemplate.schemaVersion ?? 'unknown'),
      createdAt: NOW,
      updatedAt: NOW,
      dsl: clone(couponSheetTemplate),
    },
  ];
}

/**
 * 默认种子版本历史：仅 sales-note (id=1) 一条 v1 published 版本（currentVersion=1 锚定）。
 * dslHash 经 DslParser.hash 实时计算（确定性，golden 友好）。
 */
export function buildSeedVersions(): ReadonlyArray<{
  templateId: number;
  versions: TemplateVersion[];
}> {
  const salesNoteV1Dsl = clone(sampleTemplate);
  return [
    {
      templateId: 1,
      versions: [
        {
          version: 1,
          dsl: salesNoteV1Dsl,
          dslHash: DslParser.hash(salesNoteV1Dsl as Parameters<typeof DslParser.hash>[0]),
          changeNote: '初始版本',
          status: 'published',
          publishedAt: NOW,
          publishedBy: 0,
        },
      ],
    },
  ];
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
