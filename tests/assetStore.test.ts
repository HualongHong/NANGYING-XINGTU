import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAssetStore, saveAssetStore } from '../adapters/core/assetStore.js';
import {
  createAssetStore,
  addAsset,
  type AssetStore,
} from '../core/course/manageCourseAssets.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'nangying-assets-'));
  dirs.push(d);
  return d;
}

describe('assetStore（适配层 fs 存取）', () => {
  it('保存后可加载，往返一致', () => {
    const dir = tempDir();
    const file = join(dir, 'sub', 'assets.json');
    let store: AssetStore = createAssetStore();
    store = addAsset(store, {
      id: 'g1', type: 'graph', title: '课程图谱',
      createdAt: '2026-09-30T00:00:00Z', dependencies: [],
    });
    saveAssetStore(store, file);
    expect(existsSync(file)).toBe(true);
    const loaded = loadAssetStore(file);
    expect(loaded).toEqual(store);
  });

  it('文件不存在时返回空登记簿', () => {
    const dir = tempDir();
    const loaded = loadAssetStore(join(dir, 'nope.json'));
    expect(loaded).toEqual({ assets: [], history: [] });
  });
});
