import { describe, expect, it } from "vitest";

import { validateDesignDocument } from "@designer/core";

import {
  PERFORMANCE_NODE_COUNT,
  createCoreUpdateOperations,
  createServerTreeOperation,
  createThousandNodeFixture,
} from "./fixture.js";
import { nearestRankPercentile, summarizeTimings } from "./stats.js";

describe("1,000-node performance foundation", () => {
  it("builds a deterministic, valid fixture and a bounded server operation", () => {
    const first = createThousandNodeFixture();
    const second = createThousandNodeFixture();

    expect(first.document).toEqual(second.document);
    expect(Object.keys(first.document.nodes)).toHaveLength(PERFORMANCE_NODE_COUNT);
    expect(validateDesignDocument(first.document).success).toBe(true);
    expect(createCoreUpdateOperations(first)).toHaveLength(25);

    const operation = createServerTreeOperation(first, first.rootId);
    expect(operation.nodes).toHaveLength(PERFORMANCE_NODE_COUNT - 1);
    expect(Buffer.byteLength(JSON.stringify([operation]), "utf8")).toBeLessThanOrEqual(1_048_576);
  });

  it("uses a deterministic nearest-rank p50 and p95", () => {
    const samples = [9, 1, 5, 7, 3, 11, 13];
    expect(nearestRankPercentile(samples, 50)).toBe(7);
    expect(nearestRankPercentile(samples, 95)).toBe(13);
    expect(summarizeTimings(samples)).toEqual({
      samples: 7,
      minMs: 1,
      p50Ms: 7,
      p95Ms: 13,
      maxMs: 13,
    });
  });
});
