import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveGraphSnapshot,
  loadGraphSnapshot,
  listGraphSnapshotTags,
} from '../adapters/core/assetStore.js';
import { conceptNodeId, type CourseKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';

const dirs: string[] = [];
const savedEnv = process.env.NANGYING_CONFIG_DIR;
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.NANGYING_CONFIG_DIR;
  else process.env.NANGYING_CONFIG_DIR = savedEnv;
});

function useTempConfigDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'nangying-snap-'));
  dirs.push(d);
  process.env.NANGYING_CONFIG_DIR = d;
  return d;
}

function graph(entities: string[]): CourseKnowledgeGraph {
  const nodes = entities.map((label, i) => ({
    id: conceptNodeId(label), kind: 'concept' as const, label, level: 0, order: i,
  }));
  return {
    entities: nodes,
    relations: [],
    hierarchy: [],
    prerequisiteGraph: { nodes: nodes.map((n) => n.id), edges: [], topoOrder: nodes.map((n) => n.id) },
  };
}

describe('图谱快照存储', () => {
  it('存取与标签列表；缺省取最新；不存在返回 undefined', () => {
    useTempConfigDir();
    const g1 = graph(['离心', '比色法']);
    const g2 = graph(['离心', '电泳']);
    saveGraphSnapshot('生化实验', 'v1', g1);
    saveGraphSnapshot('生化实验', 'v2', g2);
    expect(listGraphSnapshotTags('生化实验')).toEqual(['v1', 'v2']);
    expect(loadGraphSnapshot('生化实验', 'v1')).toEqual(g1);
    expect(loadGraphSnapshot('生化实验')).toEqual(g2); // 最新
    expect(loadGraphSnapshot('生化实验', 'v9')).toBeUndefined();
    expect(loadGraphSnapshot('不存在')).toBeUndefined();
  });
});
