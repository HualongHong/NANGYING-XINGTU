import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAssetStore,
  addAsset,
  updateAsset,
  checkoutVersion,
  removeAsset,
  tagDependency,
  serializeStore,
  deserializeStore,
  manageCourseAssets,
  AssetError,
  type AssetStore,
} from '../core/course/manageCourseAssets.js';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import { configDir } from '../adapters/core/configStore.js';

// 适配层默认落盘测试：隔离配置目录，不碰真实 ~/.nangying-starmap
const dirs: string[] = [];
const savedEnv = { ...process.env };
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});
function useTempConfigDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ny-assets-'));
  dirs.push(d);
  process.env.NANGYING_CONFIG_DIR = d;
  return d;
}

const meta = (id: string, deps: string[] = []) => ({
  id,
  type: 'graph' as const,
  title: `资产 ${id}`,
  dependencies: deps,
});

function seeded(): AssetStore {
  let s = createAssetStore();
  s = addAsset(s, meta('a1'));
  s = addAsset(s, meta('b1', ['a1']));
  return s;
}

describe('manage_course_assets 内存模型', () => {
  it('CRUD：登记、更新、删除', () => {
    let s = seeded();
    expect(s.assets.map((a) => a.id)).toEqual(['a1', 'b1']);
    s = updateAsset(s, 'a1', { title: '资产 a1 v2' });
    expect(s.assets.find((a) => a.id === 'a1')!.title).toBe('资产 a1 v2');
    s = removeAsset(s, 'b1');
    expect(s.assets.map((a) => a.id)).toEqual(['a1']);
  });

  it('版本递增与检出历史版本', () => {
    let s = seeded();
    s = addAsset(s, meta('a1')); // v2
    s = updateAsset(s, 'a1', { note: 'v3' }); // v3
    const current = s.assets.find((a) => a.id === 'a1')!;
    expect(current.version).toBe(3);
    const v1 = checkoutVersion(s, 'a1', 1);
    expect(v1.title).toBe('资产 a1');
    const v2 = checkoutVersion(s, 'a1', 2);
    expect(v2.note).toBeUndefined();
    expect(() => checkoutVersion(s, 'a1', 9)).toThrow(AssetError);
    expect(s.history.filter((h) => h.id === 'a1')).toHaveLength(3);
  });

  it('依赖引用完整性：悬空依赖报错，删除被依赖资产报错', () => {
    let s = seeded();
    expect(() => addAsset(s, meta('c1', ['ghost']))).toThrow('悬空引用');
    expect(() => removeAsset(s, 'a1')).toThrow('无法删除');
    // 解除依赖后可删
    s = removeAsset(s, 'b1');
    expect(() => removeAsset(s, 'a1')).not.toThrow();
  });

  it('tagDependency 追加引用并产生新版本', () => {
    let s = createAssetStore();
    s = addAsset(s, meta('a1'));
    s = addAsset(s, meta('b1'));
    s = tagDependency(s, 'b1', 'a1');
    expect(s.assets.find((a) => a.id === 'b1')!.dependencies).toEqual(['a1']);
    expect(s.assets.find((a) => a.id === 'b1')!.version).toBe(2);
    expect(() => tagDependency(s, 'b1', 'b1')).toThrow('不能依赖自身');
  });

  it('序列化往返一致（含排序确定性）', () => {
    let s = seeded();
    s = addAsset(s, { ...meta('z9'), createdAt: '2026-09-30T00:00:00Z', license: 'CC0' });
    const round = deserializeStore(serializeStore(s));
    expect(round).toEqual(s);
    expect(JSON.stringify(round)).toBe(JSON.stringify(deserializeStore(serializeStore(round))));
  });

  it('技能主入口：操作分发与错误返回', async () => {
    const bad = await manageCourseAssets({
      operation: { op: 'register', asset: meta('x1', ['ghost']) },
      store: createAssetStore(),
    });
    expect(bad.level).toBe('unavailable');
    expect(bad.degradationNote).toContain('悬空引用');

    const ok = await manageCourseAssets({
      operation: { op: 'register', asset: meta('x1') },
      store: createAssetStore(),
    });
    expect(ok.level).toBe('full');
    expect(ok.data!.assetRegistry.map((a) => a.id)).toEqual(['x1']);
    expect(ok.data!.versionHistory).toHaveLength(1);
    expect(ok.data!.metadataRecords).toHaveLength(1);
  });
});

describe('manage_course_assets 适配层：默认落盘 + export（反馈 P0-4：register→list 跨调用丢失）', () => {
  const asset = (id: string) => ({ op: 'register', asset: { id, type: 'graph' as const, title: `资产 ${id}`, dependencies: [] } });

  it('未给存储参数：默认持久化到 NANGYING_CONFIG_DIR/assets.json，新适配器实例（模拟重启）list 可见', async () => {
    useTempConfigDir();
    const first = new LocalAdapter();
    const reg = await first.invokeSkill('manage_course_assets', { inputs: { operation: asset('p1') } });
    expect(reg.level).toBe('full');
    const regData = reg.data as { persisted: boolean; storePath: string };
    expect(regData.persisted).toBe(true);
    expect(regData.storePath).toBe(join(configDir(), 'assets.json'));
    expect(existsSync(regData.storePath)).toBe(true);

    // 跨调用（新进程语义 = 新 LocalAdapter + 空内存）：登记簿仍在
    const second = new LocalAdapter();
    const list = await second.invokeSkill('manage_course_assets', {
      inputs: { operation: { op: 'list' } },
    });
    expect(list.level).toBe('full');
    const data = list.data as { assetRegistry: Array<{ id: string }> };
    expect(data.assetRegistry.map((a) => a.id)).toContain('p1');
  });

  it('list/checkout 只读不写盘；显式 store 内存态不触发默认落盘', async () => {
    const d = useTempConfigDir();
    const adapter = new LocalAdapter();
    await adapter.invokeSkill('manage_course_assets', { inputs: { operation: asset('w1') } });
    const before = readFileSync(join(d, 'assets.json'), 'utf8');
    await adapter.invokeSkill('manage_course_assets', { inputs: { operation: { op: 'list' } } });
    expect(readFileSync(join(d, 'assets.json'), 'utf8')).toBe(before); // list 未重写

    // 显式 store 对象优先于默认文件
    const explicit = await adapter.invokeSkill('manage_course_assets', {
      inputs: {
        operation: { op: 'list' },
        store: { assets: [], history: [] },
      },
    });
    const data = explicit.data as { assetRegistry: Array<{ id: string }>; storePath: string };
    expect(data.assetRegistry).toHaveLength(0);
  });

  it('op:"export"：产出登记簿 JSON 文件并回显路径', async () => {
    const d = useTempConfigDir();
    const adapter = new LocalAdapter();
    const book = join(d, '登记簿.json');
    await adapter.invokeSkill('manage_course_assets', {
      inputs: { operation: asset('e1'), storePath: book },
    });
    const r = await adapter.invokeSkill('manage_course_assets', {
      inputs: { operation: { op: 'export' }, storePath: book },
    });
    expect(r.level).toBe('full');
    const data = r.data as { result: { exportedTo: string }; assetRegistry: Array<{ id: string }> };
    expect(data.result.exportedTo).toBe(book);
    expect(existsSync(book)).toBe(true);
    expect(data.assetRegistry.map((a) => a.id)).toContain('e1');
  });

  it('assetOperations 多元素数组：顺序执行，登记簿累积全部变更', async () => {
    useTempConfigDir();
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('manage_course_assets', {
      inputs: {
        assetOperations: [asset('m1'), asset('m2')],
      },
    });
    expect(r.level).toBe('full');
    const data = r.data as { assetRegistry: Array<{ id: string }>; operations: string[] };
    expect(data.operations).toEqual(['register', 'register']);
    expect(data.assetRegistry.map((a) => a.id).sort()).toEqual(['m1', 'm2']);
  });
});
