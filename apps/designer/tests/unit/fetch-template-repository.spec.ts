// SPDX-License-Identifier: Apache-2.0
// fetch TemplateRepository 单测（+ 回读接线，模板 API 契约）：
// 注入 fetch mock 全离线——成功路径逐端点抽样（路径/body/信封解包/DTO 映射）+
// 错误映射（409 版本冲突 / 0600007 后代守卫 / 0600001 NotFound / 0600002/0600005
// 上下文映射 / 网络失败 / 老式 R.error）+ DSL 内容回读（version/dsl 端点销账 +
// 本地缓存优先口径）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchTemplateRepository } from '../../src/template-domain/fetch-repository';
import {
  MemoryTemplateRepository,
  RollbackTargetInvalidError,
  TemplateApiError,
  TemplateDslUnavailableError,
  TemplateHasDescendantsError,
  TemplateNotFoundError,
  TemplateNoChangesError,
  TemplateVersionConflictError,
  getSharedRepository,
  resetSharedRepository,
  resolveTemplateRepository,
  type TemplateMeta,
} from '../../src/template-domain';
import { API_BASE_ENV_KEY } from '../../src/shared/env';
import type { TemplateLike } from '../../src/canvas/store';

const BASE = 'http://localhost:8866';
const P = '/admin/print/template';

// ── 响应体构造（后端统一 R 信封 + 结构化错误，Jackson 口径）──
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
const ok = (result: unknown): Response => json({ code: 0, message: 'success', result });
const err = (status: number, errorCode: string, message: string): Response =>
  json({ code: status, httpStatus: status, errorCode, message, traceId: 't-1' }, status);

type Handler = (method: string, url: string, body: unknown) => Response | Promise<Response>;

function createFetchMock(handler: Handler = () => ok(null)) {
  const calls: Array<{
    method: string;
    url: string;
    body?: unknown;
    headers: Record<string, string>;
  }> = [];
  let current = handler;
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ method, url, body, headers: (init.headers ?? {}) as Record<string, string> });
    return current(method, String(url), body);
  };
  return {
    calls,
    setHandler(h: Handler) {
      current = h;
    },
    fetchImpl: fetchImpl as unknown as typeof fetch,
  };
}

function createRepo(mock: ReturnType<typeof createFetchMock>): FetchTemplateRepository {
  return new FetchTemplateRepository({
    baseUrl: BASE,
    fetchImpl: mock.fetchImpl,
    getToken: () => 'designer-token',
  });
}

const sampleDsl: TemplateLike = {
  schemaVersion: '2.0',
  id: 'tpl-1',
  code: 'sample',
  name: '样例',
  presentations: { receipt: { width: '80mm', body: [] } },
} as TemplateLike;

/** 后端实体样例（Long→String、日期 TZ=Asia/Shanghai 字符串，JacksonConfig 实测口径） */
function entity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '12',
    name: '销售小票',
    description: 'desc',
    deviceClass: 'receipt',
    sourceTemplateId: null,
    sourceVersion: null,
    currentVersion: '0',
    status: 'draft',
    createDate: '2026-08-10 10:00:00',
    updateDate: '2026-08-10 12:30:00',
    ...overrides,
  };
}

describe('fetch repo 成功路径（逐端点抽样：模板 API 契约 路径 + body + 信封解包）', () => {
  it('list：GET /list；实体 → TemplateMeta 映射（Long 字符串/currentVersion 0→null/日期 TZ 换算）', async () => {
    const mock = createFetchMock((method, url) => {
      expect(method).toBe('GET');
      expect(url).toBe(`${BASE}${P}/list`);
      return ok([
        entity(),
        entity({
          id: '13',
          name: '标签',
          deviceClass: 'label',
          currentVersion: '2',
          status: 'published',
        }),
      ]);
    });
    const list = await createRepo(mock).list();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      id: 12,
      name: '销售小票',
      deviceClass: 'receipt',
      currentVersion: null, // 后端 0 = 从未发布
      status: 'draft',
      sourceTemplateId: null,
    });
    // 日期：2026-08-10 10:00:00 +08:00 → UTC epoch
    expect(list[0].createdAt).toBe(Date.UTC(2026, 7, 10, 2, 0, 0));
    expect(list[0].updatedAt).toBe(Date.UTC(2026, 7, 10, 4, 30, 0));
    expect(list[1]).toMatchObject({ id: 13, currentVersion: 2, status: 'published' });
  });

  it('create：POST /save（无 id）→ 新 id；初始 DSL 落 draft v1（version/save）；草稿入本地缓存', async () => {
    const mock = createFetchMock((method, url, body) => {
      if (method === 'POST' && url.endsWith(`${P}/save`)) {
        expect(body).toEqual({ name: '新模板', description: null, deviceClass: 'receipt' });
        return ok('7'); // Long → String
      }
      if (method === 'POST' && url.endsWith(`${P}/version/save`)) {
        expect(body).toMatchObject({ templateId: 7, changeNote: '' });
        expect((body as { dsl: { schemaVersion: string } }).dsl.schemaVersion).toBe('2.0');
        return ok(1);
      }
      if (method === 'GET' && url.endsWith(`${P}/info/7`))
        return ok(entity({ id: '7', name: '新模板' }));
      throw new Error(`unexpected ${method} ${url}`);
    });
    const repo = createRepo(mock);
    const created = await repo.create({ name: '新模板', deviceClass: 'receipt' });
    expect(created.id).toBe(7);
    expect(created.dslSchemaVersion).toBe('2.0');
    expect(created.dsl.presentations).toBeTruthy();
    // 草稿已缓存：get 严格口径可读回
    const got = await repo.get(7);
    expect(got?.name).toBe('新模板');
    expect(got?.dsl.schemaVersion).toBe('2.0');
  });

  it('save：POST /version/save body {templateId, dsl, changeNote:""}（滚动草稿）；返回记录带 dsl', async () => {
    const mock = createFetchMock((method, url, body) => {
      if (method === 'POST' && url.endsWith(`${P}/version/save`)) {
        expect(body).toMatchObject({ templateId: 12, changeNote: '' });
        return ok(1);
      }
      if (method === 'GET') return ok(entity());
      throw new Error(`unexpected ${method} ${url}`);
    });
    const saved = await createRepo(mock).save(12, sampleDsl);
    expect(saved.id).toBe(12);
    expect(saved.dsl).toEqual(sampleDsl);
    expect(saved.dslSchemaVersion).toBe('2.0');
  });

  it('rename：POST /rename body {id, name}（专属端点，不全量覆盖）', async () => {
    const mock = createFetchMock((method, url, body) => {
      if (method === 'POST' && url.endsWith(`${P}/rename`)) {
        expect(body).toEqual({ id: 12, name: '改名后' });
        return ok(null); // R.ok() 无 result
      }
      if (method === 'GET') return ok(entity({ name: '改名后' }));
      throw new Error(`unexpected ${method} ${url}`);
    });
    const renamed = await createRepo(mock).rename(12, '改名后');
    expect(renamed.name).toBe('改名后');
  });

  it('duplicate：POST /duplicate body {sourceId, name}；源快照已缓存时副本草稿同步缓存', async () => {
    // 先让源模板 v2 快照进缓存：save + publish
    const mock = createFetchMock((method, url, body) => {
      if (url.endsWith(`${P}/version/save`)) return ok(2);
      if (url.endsWith(`${P}/version/publish`)) return ok(null);
      if (url.endsWith(`${P}/duplicate`)) {
        expect(body).toEqual({ sourceId: 12, name: '副本' });
        return ok('20');
      }
      if (url.endsWith(`${P}/info/12`))
        return ok(entity({ currentVersion: '2', status: 'published' }));
      if (url.endsWith(`${P}/info/20`)) {
        return ok(entity({ id: '20', name: '副本', sourceTemplateId: '12', sourceVersion: '2' }));
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const repo = createRepo(mock);
    await repo.save(12, sampleDsl);
    await repo.publish(12, '发布 v2');
    const copy = await repo.duplicate(12, { name: '副本' });
    expect(copy.id).toBe(20);
    expect(copy.sourceTemplateId).toBe(12);
    expect(copy.sourceVersion).toBe(2);
    // 后端把源版本 DSL 复制为副本 draft v1（既定口径）→ 本地缓存同步，get 严格口径可读
    const got = await repo.get(20);
    expect(got?.dsl).toEqual(sampleDsl);
  });

  it('getVersions：GET /{id}/versions；draft 行 dsl 取本地缓存；返回升序（后端倒序）', async () => {
    const mock = createFetchMock((method, url) => {
      if (url.endsWith(`${P}/info/12`))
        return ok(entity({ currentVersion: '1', status: 'published' }));
      if (url.endsWith(`${P}/12/versions`)) {
        // 后端倒序 + dslContent 置空（契约 ）
        return ok([
          {
            version: 2,
            dslContent: null,
            dslHash: 'h2',
            changeNote: '',
            status: 'draft',
            publishedAt: null,
          },
          {
            version: 1,
            dslContent: null,
            dslHash: 'h1',
            changeNote: '首发',
            status: 'published',
            publishedAt: '2026-08-10 09:00:00',
            publishedBy: '9',
          },
        ]);
      }
      if (url.endsWith(`${P}/version/save`)) return ok(1);
      if (url.endsWith(`${P}/version/publish`)) return ok(null);
      throw new Error(`unexpected ${method} ${url}`);
    });
    const repo = createRepo(mock);
    await repo.save(12, sampleDsl); // 本地草稿缓存（对应 draft 行）
    await repo.publish(12, '首发'); // v1 快照进本地缓存（publish 两步经同 handler）
    // publish 已消费 draft 缓存（晋升快照）；重新 save 让 draft 行内容已知
    await repo.save(12, sampleDsl);
    const versions = await repo.getVersions(12);
    expect(versions.map((v) => v.version)).toEqual([1, 2]); // 升序
    expect(versions[0]).toMatchObject({
      version: 1,
      status: 'published',
      dslHash: 'h1',
      changeNote: '首发',
      publishedBy: 9,
    });
    expect(versions[0].publishedAt).toBe(Date.UTC(2026, 7, 10, 1, 0, 0));
    expect(versions[0].dsl).toEqual(sampleDsl); // 本地快照供给
    expect(versions[1]).toMatchObject({ version: 2, status: 'draft' });
    expect(versions[1].dsl).toEqual(sampleDsl); // 本地草稿供给
  });

  it('publish：两步拼装 version/save → version/publish；快照入缓存；changeNote 透传', async () => {
    const seq: Array<{ step: string; changeNote?: string }> = [];
    const mock = createFetchMock((method, url, body) => {
      if (url.endsWith(`${P}/info/12`)) return ok(entity());
      if (url.endsWith(`${P}/version/save`)) {
        seq.push({
          step: 'version/save',
          changeNote: (body as { changeNote?: string }).changeNote,
        });
        return ok(3);
      }
      if (url.endsWith(`${P}/version/publish`)) {
        seq.push({ step: 'version/publish' });
        expect(body).toEqual({ templateId: 12, version: 3 });
        return ok(null);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const repo = createRepo(mock);
    await repo.save(12, sampleDsl); // setup：滚动草稿落库（changeNote=''）
    const published = await repo.publish(12, '首发');
    expect(seq.map((s) => s.step)).toEqual(['version/save', 'version/save', 'version/publish']);
    expect(seq[0].changeNote).toBe(''); // save 步：滚动草稿空备注
    expect(seq[1].changeNote).toBe('首发'); // publish 步：changeNote 透传
    expect(published.id).toBe(12);
    // publish 后 get：currentVersion 快照缓存供给 DSL
    mock.setHandler((_m, url) => {
      if (url.endsWith(`${P}/info/12`))
        return ok(entity({ currentVersion: '3', status: 'published' }));
      throw new Error(`unexpected ${url}`);
    });
    const got = await repo.get(12);
    expect(got?.currentVersion).toBe(3);
    expect(got?.dsl).toEqual(sampleDsl);
  });

  it('publish 幂等防护：草稿与 currentVersion 快照 hash 相同 → TemplateNoChangesError（不发请求）', async () => {
    const mock = createFetchMock((method, url) => {
      if (url.endsWith(`${P}/info/12`)) return ok(entity());
      if (url.endsWith(`${P}/version/save`)) return ok(1);
      if (url.endsWith(`${P}/version/publish`)) return ok(null);
      throw new Error(`unexpected ${method} ${url}`);
    });
    const repo = createRepo(mock);
    await repo.save(12, sampleDsl);
    await repo.publish(12, '首发');
    // 重新 save 相同内容 → 草稿 hash == v1 快照 hash
    await repo.save(12, sampleDsl);
    mock.setHandler((_m, url) => {
      if (url.endsWith(`${P}/info/12`))
        return ok(entity({ currentVersion: '1', status: 'published' }));
      throw new Error(`不应再有写请求：${url}`);
    });
    await expect(repo.publish(12, '重复')).rejects.toThrow(TemplateNoChangesError);
  });

  it('rollback：POST /version/rollback body {templateId, version}；本地草稿同步目标快照', async () => {
    const oldDsl = { ...sampleDsl, name: '旧版' } as TemplateLike;
    const mock = createFetchMock((method, url, body) => {
      if (url.endsWith(`${P}/version/save`)) return ok(1);
      if (url.endsWith(`${P}/version/publish`)) return ok(null);
      if (url.endsWith(`${P}/version/rollback`)) {
        expect(body).toEqual({ templateId: 12, version: 1 });
        return ok(null);
      }
      if (url.endsWith(`${P}/info/12`))
        return ok(entity({ currentVersion: '1', status: 'published' }));
      throw new Error(`unexpected ${method} ${url}`);
    });
    const repo = createRepo(mock);
    await repo.save(12, oldDsl);
    await repo.publish(12, 'v1');
    await repo.save(12, sampleDsl); // 草稿改写
    await repo.rollback(12, 1);
    // 草稿同步回滚到 v1 快照
    const got = await repo.get(12);
    expect(got?.dsl).toEqual(oldDsl);
  });

  it('remove：delete-check 无后代 → POST /delete；本地缓存清理', async () => {
    const seq: string[] = [];
    const mock = createFetchMock((method, url, body) => {
      if (url.endsWith(`${P}/delete-check`)) {
        seq.push('check');
        expect(body).toEqual({ id: 12 });
        return ok({ hasDescendants: false, descendants: [] });
      }
      if (url.endsWith(`${P}/delete`)) {
        seq.push('delete');
        expect(body).toEqual({ id: 12 });
        return ok(null);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const repo = createRepo(mock);
    await repo.remove(12);
    expect(seq).toEqual(['check', 'delete']);
  });

  it('getLineage：GET /{id}/lineage；节点 join list 全量 meta；descendants 按 updatedAt 倒序', async () => {
    const mock = createFetchMock((method, url) => {
      if (url.endsWith(`${P}/12/lineage`)) {
        return ok({
          ancestors: [
            {
              id: '9',
              name: '父',
              currentVersion: '1',
              updatedAt: '2026-08-09 10:00:00',
              depth: 1,
            },
          ],
          descendants: [
            {
              id: '30',
              name: '孙',
              currentVersion: '0',
              updatedAt: '2026-08-10 08:00:00',
              depth: 2,
            },
            {
              id: '20',
              name: '子',
              currentVersion: '1',
              updatedAt: '2026-08-10 09:00:00',
              depth: 1,
            },
          ],
        });
      }
      if (url.endsWith(`${P}/list`)) {
        return ok([
          entity({ id: '9', name: '父（全量）', updateDate: '2026-08-09 10:00:00' }),
          entity({ id: '20', name: '子（全量）', updateDate: '2026-08-10 09:00:00' }),
        ]);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const lin = await createRepo(mock).getLineage(12);
    expect(lin.ancestors).toHaveLength(1);
    expect(lin.ancestors[0].name).toBe('父（全量）'); // join 命中 list 全量 meta
    expect(lin.descendants.map((d) => d.id)).toEqual([20, 30]); // updatedAt 倒序（30 无 join 走节点派生）
    expect(lin.descendants[1].name).toBe('孙');
  });

  it('鉴权：getToken 有值 → 全部请求附 Authorization: Bearer（设计器会话 token）', async () => {
    const mock = createFetchMock((_m, url) => {
      if (url.endsWith(`${P}/list`)) return ok([]);
      throw new Error(`unexpected ${url}`);
    });
    await createRepo(mock).list();
    expect(mock.calls[0].headers.Authorization).toBe('Bearer designer-token');
  });
});

describe('fetch repo 错误映射（模板 API 契约 + domain 类型化）', () => {
  it('get：404/0600001 → null（接口契约）', async () => {
    const mock = createFetchMock(() => err(404, '0600001', '打印模板不存在'));
    expect(await createRepo(mock).get(999)).toBeNull();
  });

  it('save：0600001 → TemplateNotFoundError', async () => {
    const mock = createFetchMock(() => err(404, '0600001', '打印模板不存在'));
    await expect(createRepo(mock).save(999, sampleDsl)).rejects.toThrow(TemplateNotFoundError);
  });

  it('409 → TemplateVersionConflictError（409 = 版本冲突）', async () => {
    let saveCalls = 0;
    const mock = createFetchMock((method, url) => {
      if (url.endsWith(`${P}/info/12`)) return ok(entity());
      if (url.endsWith(`${P}/version/save`)) {
        saveCalls += 1;
        return saveCalls === 1 ? ok(1) : err(409, '0600005', '模板版本冲突');
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const repo = createRepo(mock);
    await repo.save(12, sampleDsl); // 首次 version/save 成功（草稿落库）
    await expect(repo.publish(12, '冲突')).rejects.toThrow(TemplateVersionConflictError);
  });

  it('rollback：0600002 版本不存在 / 0600005 非 published → RollbackTargetInvalidError', async () => {
    const t1 = createRepo(createFetchMock(() => err(422, '0600002', '版本不存在')));
    await expect(t1.rollback(12, 9)).rejects.toThrow(RollbackTargetInvalidError);
    const t2 = createRepo(createFetchMock(() => err(422, '0600005', '只能回滚到已发布版本')));
    await expect(t2.rollback(12, 2)).rejects.toThrow(/仅 published 版本可回滚/);
  });

  it('remove：delete-check 有后代 → TemplateHasDescendantsError（不发 /delete）', async () => {
    const seq: string[] = [];
    const mock = createFetchMock((_m, url) => {
      seq.push(url);
      if (url.endsWith(`${P}/delete-check`)) {
        return ok({
          hasDescendants: true,
          descendants: [
            { id: '20', name: '副本A' },
            { id: '21', name: '副本B' },
          ],
        });
      }
      return ok(null);
    });
    const repo = createRepo(mock);
    await expect(repo.remove(12)).rejects.toBeInstanceOf(TemplateHasDescendantsError);
    await expect(repo.remove(12)).rejects.toMatchObject({
      templateId: 12,
      descendantIds: [20, 21],
    });
    expect(seq.some((u) => u.endsWith(`${P}/delete`))).toBe(false);
  });

  it('remove：delete 并发竞态 0600007 → TemplateHasDescendantsError（message 内嵌清单解析）', async () => {
    const mock = createFetchMock((method, url) => {
      if (url.endsWith(`${P}/delete-check`)) return ok({ hasDescendants: false, descendants: [] });
      if (url.endsWith(`${P}/delete`)) {
        return err(422, '0600007', '模板存在后代引用，禁止删除：[{"id":20,"name":"副本A"}]');
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await expect(createRepo(mock).remove(12)).rejects.toMatchObject({
      code: 'TEMPLATE_HAS_DESCENDANTS',
      descendantIds: [20],
    });
  });

  it('version/save DSL 校验失败→ TemplateApiError 携带 errorCode', async () => {
    const mock = createFetchMock(() => err(422, '0600003', '模板 DSL 校验失败：x'));
    try {
      await createRepo(mock).save(12, sampleDsl);
      throw new Error('应当抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateApiError);
      expect((e as TemplateApiError).errorCode).toBe('0600003');
      expect((e as TemplateApiError).status).toBe(422);
    }
  });

  it('rename 非法名称→ TemplateApiError 兜底（未类型化码保留 errorCode）', async () => {
    const mock = createFetchMock(() => err(422, '0600008', '模板名称不合法'));
    try {
      await createRepo(mock).rename(12, '');
      throw new Error('应当抛错');
    } catch (e) {
      expect((e as TemplateApiError).errorCode).toBe('0600008');
    }
  });

  it('老式 R.error（200 + {code:500} 无 result）→ TemplateApiError', async () => {
    const mock = createFetchMock(() => json({ code: 500, message: 'id 不能为空' }));
    await expect(createRepo(mock).rename(12, 'x')).rejects.toMatchObject({ status: 500 });
  });

  it('网络失败（fetch 拒绝）→ TemplateApiError（无 status）', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const repo = new FetchTemplateRepository({ baseUrl: BASE, fetchImpl, getToken: () => null });
    try {
      await repo.list();
      throw new Error('应当抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateApiError);
      expect((e as TemplateApiError).status).toBeUndefined();
      expect((e as Error).message).toContain('网络请求失败');
    }
  });
});

describe('fetch repo DSL 内容回读语义（销账：version/dsl 端点）', () => {
  it('get：本地缓存缺失 → GET version/dsl 回读成功；写回会话缓存', async () => {
    const mock = createFetchMock((_m, url) => {
      if (url.endsWith(`${P}/info/12`))
        return ok(entity({ currentVersion: '2', status: 'published' }));
      if (url.endsWith(`${P}/version/dsl?templateId=12&version=2`)) return ok(sampleDsl);
      throw new Error(`unexpected ${url}`);
    });
    const repo = createRepo(mock);
    const rec = await repo.get(12);
    expect(rec?.dsl).toMatchObject({ code: 'sample', name: '样例' });
    expect(rec?.dslSchemaVersion).toBe('2.0');
    // 快照已入缓存：二次 get 不再打回读腿（仅 info）
    mock.setHandler((_m, url) => {
      if (url.endsWith(`${P}/info/12`))
        return ok(entity({ currentVersion: '2', status: 'published' }));
      throw new Error(`unexpected second-pass ${url}`);
    });
    const again = await repo.get(12);
    expect(again?.dsl).toMatchObject({ code: 'sample' });
  });

  it('get：未发布（currentVersion=0→null）回读 draft v1；0600002 → TemplateDslUnavailableError', async () => {
    const mock = createFetchMock((_m, url) => {
      if (url.endsWith(`${P}/info/12`)) return ok(entity());
      if (url.endsWith(`${P}/version/dsl?templateId=12&version=1`))
        return err(422, '0600002', '版本不存在');
      throw new Error(`unexpected ${url}`);
    });
    await expect(createRepo(mock).get(12)).rejects.toThrow(TemplateDslUnavailableError);
  });

  it('get：回读腿网络失败 → TemplateApiError 原样上抛', async () => {
    const fetchImpl = (async (_url: string) => {
      if (String(_url).endsWith(`${P}/info/12`)) return ok(entity());
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const repo = new FetchTemplateRepository({ baseUrl: BASE, fetchImpl, getToken: () => null });
    await expect(repo.get(12)).rejects.toThrow(TemplateApiError);
  });

  it('getVersions：行缓存缺失 → 逐行回读成功（draft 写草稿缓存、published 写快照）', async () => {
    const mock = createFetchMock((_m, url) => {
      if (url.endsWith(`${P}/info/12`))
        return ok(entity({ currentVersion: '1', status: 'published' }));
      if (url.endsWith('/12/versions')) {
        return ok([
          { version: 2, dslHash: 'h2', changeNote: 'draft', status: 'draft', publishedAt: null },
          { version: 1, dslHash: 'h1', changeNote: 'x', status: 'published', publishedAt: null },
        ]);
      }
      if (url.endsWith(`${P}/version/dsl?templateId=12&version=1`)) return ok(sampleDsl);
      if (url.endsWith(`${P}/version/dsl?templateId=12&version=2`))
        return ok({ ...sampleDsl, name: '草稿版' });
      throw new Error(`unexpected ${url}`);
    });
    const versions = await createRepo(mock).getVersions(12);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0].dsl).toMatchObject({ name: '样例' });
    expect(versions[1].dsl).toMatchObject({ name: '草稿版' });
  });

  it('getVersions：回读 0600002 → TemplateDslUnavailableError', async () => {
    const mock = createFetchMock((_m, url) => {
      if (url.endsWith(`${P}/info/12`))
        return ok(entity({ currentVersion: '1', status: 'published' }));
      if (url.endsWith('/12/versions')) {
        return ok([
          { version: 1, dslHash: 'h', changeNote: 'x', status: 'published', publishedAt: null },
        ]);
      }
      if (url.endsWith(`${P}/version/dsl?templateId=12&version=1`))
        return err(422, '0600002', 'dsl_content 为空');
      throw new Error(`unexpected ${url}`);
    });
    await expect(createRepo(mock).getVersions(12)).rejects.toThrow(TemplateDslUnavailableError);
  });

  it('publish：无本地草稿且后端无 draft 行 → TemplateDslUnavailableError', async () => {
    const mock = createFetchMock((_m, url) => {
      if (url.endsWith(`${P}/info/12`)) return ok(entity());
      if (url.endsWith('/12/versions')) return ok([]); // 无 draft 行
      throw new Error(`unexpected ${url}`);
    });
    await expect(createRepo(mock).publish(12, 'x')).rejects.toThrow(TemplateDslUnavailableError);
  });

  it('rename/duplicate 等非画布路径：DSL 未知时宽松返回骨架（不抛错）', async () => {
    const mock = createFetchMock((method, url) => {
      if (url.endsWith(`${P}/rename`)) return ok(null);
      // rename 后端落库后 info 回读即新名（专属端点只更新 name 单列）
      if (url.endsWith(`${P}/info/12`)) return ok(entity({ name: '新名' }));
      throw new Error(`unexpected ${method} ${url}`);
    });
    const renamed = await createRepo(mock).rename(12, '新名');
    expect(renamed.name).toBe('新名');
    expect(renamed.dsl.schemaVersion).toBe('2.0'); // 最小骨架占位
  });
});

describe('FetchTemplateRepository 构造口径', () => {
  it('baseUrl 尾斜杠归一；getToken 缺省读 session-api 内存 token（本测注入 null 不附头）', async () => {
    const mock = createFetchMock((_m, url) => {
      expect(url).toBe(`${BASE}${P}/list`); // 无双斜杠
      return ok([]);
    });
    const repo = new FetchTemplateRepository({
      baseUrl: `${BASE}/`,
      fetchImpl: mock.fetchImpl,
      getToken: () => null,
    });
    await repo.list();
    expect(mock.calls[0].headers.Authorization).toBeUndefined();
  });
});

// meta 映射零散补强：description null → undefined、未知 deviceClass → 'doc'
describe('fetch repo DTO 映射边界', () => {
  it('description null/缺失 → undefined；deviceClass 未知值 → doc 兜底；archived 状态透传', async () => {
    const mock = createFetchMock(() =>
      ok([entity({ description: null, deviceClass: 'unknown-x', status: 'archived' })]),
    );
    const [meta] = await createRepo(mock).list();
    expect(meta.description).toBeUndefined();
    expect(meta.deviceClass).toBe('doc');
    expect(meta.status).toBe('archived');
    expect((meta as TemplateMeta).dslSchemaVersion).toBe('unknown');
  });
});

// 组合根工厂开关（模板 API 契约/C4；与 session 开关同口径：同一 VITE_SESSION_API_BASE，
// 有值 → fetch 真实后端，缺省 → memory mock 保既有基线语义不变）。
describe('Template Repository 工厂环境开关（resolveTemplateRepository / getSharedRepository）', () => {
  afterEach(() => {
    resetSharedRepository();
    vi.unstubAllEnvs();
  });

  it('工厂纯函数：apiBase 有值 → FetchTemplateRepository；缺省 → MemoryTemplateRepository（带 seed）', async () => {
    expect(resolveTemplateRepository('http://localhost:8866')).toBeInstanceOf(
      FetchTemplateRepository,
    );
    const mem = resolveTemplateRepository(null);
    expect(mem).toBeInstanceOf(MemoryTemplateRepository);
    expect((await mem.list()).length).toBeGreaterThan(0); // 默认 seed 注入
  });

  it('getSharedRepository：VITE_SESSION_API_BASE 有值 → fetch 形态', () => {
    vi.stubEnv(API_BASE_ENV_KEY, 'http://localhost:8866');
    expect(getSharedRepository()).toBeInstanceOf(FetchTemplateRepository);
  });

  it('getSharedRepository：开关缺省/空串 → memory 形态（既有基线行为不变）', () => {
    vi.stubEnv(API_BASE_ENV_KEY, '');
    expect(getSharedRepository()).toBeInstanceOf(MemoryTemplateRepository);
    resetSharedRepository();
    vi.unstubAllEnvs(); // 完全缺省（测试环境无 .env 注入）
    expect(getSharedRepository()).toBeInstanceOf(MemoryTemplateRepository);
  });
});
