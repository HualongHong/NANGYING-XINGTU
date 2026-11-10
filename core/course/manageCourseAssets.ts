/**
 * 课程资产管理（manage_course_assets）——N2 收尾切片。
 *
 * 资产管理是纯逻辑契约：core 只做内存模型 CRUD + 版本/依赖管理 +
 * 序列化（零 Node API、不落盘、不依赖 Date.now——createdAt 由调用方传入）。
 * 文件系统落盘由适配层 adapters/core/assetStore.ts 实现。
 */

export const MANAGE_COURSE_ASSETS_ID = 'manage_course_assets';

export type AssetType =
  | 'material'
  | 'graph'
  | 'script'
  | 'package'
  | 'video'
  | 'subtitle'
  | 'other';

/** 资产元数据（version 由登记簿管理，调用方不传） */
export interface AssetMetadata {
  id: string;
  type: AssetType;
  title: string;
  lang?: string;
  version: number;
  /** ISO 时间串，由调用方传入（core 不取系统时间，保证确定性） */
  createdAt?: string;
  /** 引用的其他资产 id */
  dependencies: string[];
  checksum?: string;
  license?: string;
  note?: string;
}

/** 一条版本历史记录 */
export interface VersionRecord {
  id: string;
  version: number;
  metadata: AssetMetadata;
}

/** 资产登记簿（内存模型） */
export interface AssetStore {
  /** 各资产当前版本（按 id 排序，确定性） */
  assets: AssetMetadata[];
  /** 全部版本历史（含当前），按 id、version 排序 */
  history: VersionRecord[];
}

export class AssetError extends Error {}

export function createAssetStore(): AssetStore {
  return { assets: [], history: [] };
}

function sortStore(store: AssetStore): AssetStore {
  return {
    assets: [...store.assets].sort((a, b) => a.id.localeCompare(b.id)),
    history: [...store.history].sort(
      (a, b) => a.id.localeCompare(b.id) || a.version - b.version,
    ),
  };
}

function currentVersion(store: AssetStore, id: string): number {
  const versions = store.history.filter((h) => h.id === id).map((h) => h.version);
  return versions.length === 0 ? 0 : Math.max(...versions);
}

function assertDependenciesExist(store: AssetStore, id: string, deps: string[]): void {
  const missing = deps.filter((d) => d !== id && !store.assets.some((a) => a.id === d));
  if (missing.length > 0) {
    throw new AssetError(`依赖的资产不存在：${missing.join('、')}（悬空引用）`);
  }
}

/** 登记新资产（同 id 再次登记视为新版本，version 递增） */
export function addAsset(
  store: AssetStore,
  meta: Omit<AssetMetadata, 'version'>,
): AssetStore {
  if (!meta.id) throw new AssetError('资产 id 不能为空');
  assertDependenciesExist(store, meta.id, meta.dependencies ?? []);
  const version = currentVersion(store, meta.id) + 1;
  const record: AssetMetadata = { ...meta, version, dependencies: meta.dependencies ?? [] };
  const assets = [...store.assets.filter((a) => a.id !== meta.id), record];
  return sortStore({
    assets,
    history: [...store.history, { id: meta.id, version, metadata: record }],
  });
}

/** 更新资产（产生新版本；patch 不可改 id 与 version） */
export function updateAsset(
  store: AssetStore,
  id: string,
  patch: Partial<Omit<AssetMetadata, 'id' | 'version'>>,
): AssetStore {
  const current = store.assets.find((a) => a.id === id);
  if (!current) throw new AssetError(`资产 ${id} 不存在`);
  const next: AssetMetadata = { ...current, ...patch, id, version: current.version + 1 };
  assertDependenciesExist(store, id, next.dependencies);
  return sortStore({
    assets: [...store.assets.filter((a) => a.id !== id), next],
    history: [...store.history, { id, version: next.version, metadata: next }],
  });
}

/** 检出历史版本 */
export function checkoutVersion(store: AssetStore, id: string, version: number): AssetMetadata {
  const record = store.history.find((h) => h.id === id && h.version === version);
  if (!record) throw new AssetError(`资产 ${id} 无版本 ${version}`);
  return record.metadata;
}

/** 删除资产：被其他资产依赖时报错（拒绝产生悬空引用） */
export function removeAsset(store: AssetStore, id: string): AssetStore {
  const dependents = store.assets.filter((a) => a.dependencies.includes(id));
  if (dependents.length > 0) {
    throw new AssetError(
      `资产 ${id} 被以下资产引用，无法删除：${dependents.map((d) => d.id).join('、')}`,
    );
  }
  return sortStore({
    assets: store.assets.filter((a) => a.id !== id),
    history: store.history.filter((h) => h.id !== id),
  });
}

/** 追加依赖引用（校验目标存在） */
export function tagDependency(store: AssetStore, id: string, dependencyId: string): AssetStore {
  if (id === dependencyId) throw new AssetError('资产不能依赖自身');
  const current = store.assets.find((a) => a.id === id);
  if (!current) throw new AssetError(`资产 ${id} 不存在`);
  return updateAsset(store, id, { dependencies: [...current.dependencies, dependencyId] });
}

// ---------- 序列化 ----------

export function serializeStore(store: AssetStore): string {
  return JSON.stringify(sortStore(store), null, 2);
}

export function deserializeStore(json: string): AssetStore {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null ||
      !Array.isArray((parsed as AssetStore).assets) || !Array.isArray((parsed as AssetStore).history)) {
    throw new AssetError('资产登记簿 JSON 结构非法');
  }
  return sortStore(parsed as AssetStore);
}

// ---------- 技能主入口（操作分发，供执行器与直接调用使用） ----------

export type AssetOp =
  | { op: 'register'; asset: Omit<AssetMetadata, 'version'> }
  | { op: 'update'; id: string; patch: Partial<Omit<AssetMetadata, 'id' | 'version'>> }
  | { op: 'checkout'; id: string; version: number }
  | { op: 'remove'; id: string }
  | { op: 'tagDependency'; id: string; dependencyId: string }
  | { op: 'list' };

import type { SkillResult } from '../types.js';

export interface ManageAssetsOutput {
  store: AssetStore;
  /** checkout 检出的历史版本 */
  result?: AssetMetadata;
  assetRegistry: AssetMetadata[];
  versionHistory: VersionRecord[];
  metadataRecords: AssetMetadata[];
}

export async function manageCourseAssets(input: {
  operation: AssetOp;
  store: AssetStore;
}): Promise<SkillResult<ManageAssetsOutput>> {
  const { operation, store } = input;
  try {
    let next = store;
    let result: AssetMetadata | undefined;
    switch (operation.op) {
      case 'register':
        next = addAsset(store, operation.asset);
        break;
      case 'update':
        next = updateAsset(store, operation.id, operation.patch);
        break;
      case 'checkout':
        result = checkoutVersion(store, operation.id, operation.version);
        break;
      case 'remove':
        next = removeAsset(store, operation.id);
        break;
      case 'tagDependency':
        next = tagDependency(store, operation.id, operation.dependencyId);
        break;
      case 'list':
        break;
    }
    return {
      skillId: MANAGE_COURSE_ASSETS_ID,
      level: 'full',
      data: {
        store: next,
        result,
        assetRegistry: next.assets,
        versionHistory: next.history,
        metadataRecords: next.history.map((h) => h.metadata),
      },
      degradationNote: '',
    };
  } catch (err) {
    return {
      skillId: MANAGE_COURSE_ASSETS_ID,
      level: 'unavailable',
      degradationNote: err instanceof Error ? err.message : String(err),
    };
  }
}
