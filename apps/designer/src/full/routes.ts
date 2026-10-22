// SPDX-License-Identifier: Apache-2.0
import { createRouter, createWebHistory } from 'vue-router';

// full 模式路由（设计契约）
// 迭代：新增 /lineage/:id（血缘视图，替换 LineagePage 实体）；/design/:id 支持数字
// 主键（Repository id）；/design/sample 作为兼容路由在路由层 redirect 到 /design/1
// （sales-note seed），既存 e2e 流程 open-designer → sample-select 经此保持通过。
// 注：路由层 redirect 比 DesignerPage 内部 router.replace 更可靠——后者在参数变化时
// component 实例复用、不重新触发 onMounted/setup，会导致 sample→1 切换后模板不重新加载。
export function createFullRouter() {
  return createRouter({
    // base 必须取构建 base（生产 --base=/designer/ 部署于子路径）——缺省 '/' 时
    // URL /designer/ 匹配不到任何路由 = 落地页整面空白（2026-10-12 生产实测）；
    // dev BASE_URL=/ 行为不变，e2e 不受影响。
    history: createWebHistory(import.meta.env.BASE_URL),
    routes: [
      {
        path: '/',
        name: 'template-list',
        component: () => import('./pages/TemplateListPage.vue'),
      },
      {
        // 兼容路由：既存 e2e 与早期链路均经此；seed 首个模板（sales-note）id=1
        path: '/design/sample',
        redirect: { name: 'designer', params: { id: '1' } },
      },
      {
        path: '/design/:id',
        name: 'designer',
        component: () => import('./pages/DesignerPage.vue'),
      },
      {
        path: '/versions/:id',
        name: 'version-history',
        component: () => import('./pages/VersionHistoryPage.vue'),
      },
      {
        path: '/lineage/:id',
        name: 'template-lineage',
        component: () => import('./pages/LineagePage.vue'),
      },
    ],
  });
}
