import { performance } from "node:perf_hooks";

export interface SampleOptions {
  warmupIterations: number;
  iterations: number;
}

export interface SampleResult<T> {
  durationsMs: number[];
  lastValue: T;
}

export interface TimingSummary {
  samples: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export function nearestRankPercentile(values: readonly number[], percentile: number): number {
  if (values.length === 0) throw new Error("At least one timing sample is required.");
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 100) {
    throw new Error("Percentile must be greater than 0 and at most 100.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1));
  return sorted[index]!;
}

export function summarizeTimings(values: readonly number[]): TimingSummary {
  return {
    samples: values.length,
    minMs: Math.min(...values),
    p50Ms: nearestRankPercentile(values, 50),
    p95Ms: nearestRankPercentile(values, 95),
    maxMs: Math.max(...values),
  };
}

export async function sampleTask<T>(task: () => T | Promise<T>, options: SampleOptions): Promise<SampleResult<T>> {
  let lastValue: T | undefined;
  for (let index = 0; index < options.warmupIterations; index += 1) lastValue = await task();

  const durationsMs: number[] = [];
  for (let index = 0; index < options.iterations; index += 1) {
    const startedAt = performance.now();
    lastValue = await task();
    durationsMs.push(performance.now() - startedAt);
  }
  if (lastValue === undefined) throw new Error("The sampled task did not run.");
  return { durationsMs, lastValue };
}
