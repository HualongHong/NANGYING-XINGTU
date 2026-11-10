/**
 * 资产登记簿的本地文件存取（适配层，允许 Node API）。
 * 简单方案：JSON 单文件；保存时原子写（先写临时文件再重命名）。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createAssetStore,
  deserializeStore,
  serializeStore,
  type AssetStore,
} from '../../core/course/manageCourseAssets.js';

/** 从 JSON 文件加载登记簿；文件不存在时返回空登记簿 */
export function loadAssetStore(filePath: string): AssetStore {
  if (!existsSync(filePath)) return createAssetStore();
  return deserializeStore(readFileSync(filePath, 'utf8'));
}

/** 保存登记簿到 JSON 文件（自动创建目录，原子写入） */
export function saveAssetStore(store: AssetStore, filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, serializeStore(store), 'utf8');
  renameSync(tmp, filePath);
}

// ---------- 图谱快照存储（版本比对的前提） ----------

import type { CourseKnowledgeGraph } from '../../core/graph/extractKnowledgeGraph.js';
import { configDir } from './configStore.js';

function graphSnapshotDir(courseId: string): string {
  const safe = courseId.replace(/[\/:*?"<>|\s]/g, '_');
  return join(configDir(), 'graphs', safe);
}

/** 存图谱快照：courseId + versionTag（如 v1、2026-10） */
export function saveGraphSnapshot(
  courseId: string,
  versionTag: string,
  graph: CourseKnowledgeGraph,
): string {
  const dir = graphSnapshotDir(courseId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${versionTag}.graph.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(graph, null, 2), 'utf8');
  renameSync(tmp, file);
  return file;
}

/** 取图谱快照；versionTag 缺省取最新（按文件名排序） */
export function loadGraphSnapshot(
  courseId: string,
  versionTag?: string,
): CourseKnowledgeGraph | undefined {
  const dir = graphSnapshotDir(courseId);
  let file: string;
  if (versionTag) {
    file = join(dir, `${versionTag}.graph.json`);
    if (!existsSync(file)) return undefined;
  } else {
    const tags = listGraphSnapshotTags(courseId);
    if (tags.length === 0) return undefined;
    file = join(dir, `${tags[tags.length - 1]}.graph.json`);
  }
  return JSON.parse(readFileSync(file, 'utf8')) as CourseKnowledgeGraph;
}

/** 列出课程的快照标签（字典序） */
export function listGraphSnapshotTags(courseId: string): string[] {
  const dir = graphSnapshotDir(courseId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.graph.json'))
    .map((f) => f.replace(/\.graph\.json$/, ''))
    .sort();
}