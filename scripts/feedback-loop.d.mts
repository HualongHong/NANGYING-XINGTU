/** scripts/feedback-loop.mjs 的类型声明（供 vitest 直接导入纯函数测试） */

export interface LoopIndexEntry {
  docId: string;
  acceptedAt: string;
  kind: string;
  summary: string;
  hasSensitive: boolean;
  reviewComment?: string;
  consumed?: boolean;
}

export interface LoopMetrics {
  total: number;
  byKind: Record<string, number>;
  sensitiveCount: number;
  sensitiveRatio: number;
  unconsumedIssues: number;
  oldestUnconsumedAgeDays: number;
  consumed: number;
}

export interface LoopThresholds {
  minFeedbackBeforeGating: number;
  maxUnconsumedIssues: number;
  maxSensitiveAttachedRatio: number;
  stalenessWarnDays: number;
  [key: string]: unknown;
}

export interface LoopBreach {
  metric: string;
  value: number;
  threshold: number;
  message: string;
}

export interface LoopVerdict {
  active: boolean;
  breaches: LoopBreach[];
  note?: string;
}

export declare const DEFAULT_THRESHOLDS: LoopThresholds;
export declare function loadThresholds(file?: string): LoopThresholds;
export declare function loadIndex(rootDir: string): { entries: LoopIndexEntry[]; warnings: string[] };
export declare function computeMetrics(entries: LoopIndexEntry[], now?: Date): LoopMetrics;
export declare function evaluateThresholds(metrics: LoopMetrics, thresholds: LoopThresholds): LoopVerdict;
