// SPDX-License-Identifier: Apache-2.0
// 样例模板：一页多单 fixture（fixtures/templates/coupon-sheet-v2.0.json， 锚点物）——
// nup 2×2 + image 水印；加载链路同 sales-note.ts 口径。
import couponSheetJson from '../../../samples/coupon-sheet-v2.0.json';
import type { TemplateLike } from '../store';

export const couponSheetTemplate = couponSheetJson as unknown as TemplateLike;
