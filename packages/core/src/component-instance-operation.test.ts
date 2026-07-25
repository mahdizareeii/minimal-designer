import { describe, expect, it } from "vitest";

import {
  DesignOperationSchema,
  OperationApplicationError,
  applyOperations,
  createSequentialIdFactory,
  createStarterDocument,
} from "./index.js";

describe("server-resolved component instance operations", () => {
  const operation = {
    type: "insert_component_instance" as const,
    parent: { page_id: "page_component_operation_01" },
    component_definition_id: "component_operation_button_01",
    component_version: 3,
    source_hash: "a".repeat(64),
    instance_id: "node_component_instance_01",
    active_state: "hover" as const,
    properties: {},
    slots: {},
    visual_overrides: {},
    index: 0,
    position: { x: 24.5, y: 36.25 },
  };

  it("accepts only bounded reference evidence and no caller-supplied source tree", () => {
    expect(DesignOperationSchema.parse(operation)).toEqual(operation);
    expect(DesignOperationSchema.safeParse({ ...operation, source: { nodes: [] } }).success).toBe(false);
    expect(DesignOperationSchema.safeParse({ ...operation, source_hash: "not-a-hash" }).success).toBe(false);
  });

  it("cannot be applied without the server release resolver", () => {
    const ids = createSequentialIdFactory("componentoperation");
    const document = createStarterDocument({
      now: "2026-07-21T00:00:00.000Z",
      idFactory: ids,
    });
    const prepared = { ...operation, parent: { page_id: document.pages[0]!.id } };
    expect(() => applyOperations(document, [prepared])).toThrowError(OperationApplicationError);
    try {
      applyOperations(document, [prepared]);
    } catch (error) {
      expect(error).toMatchObject({ code: "operation_failed", operation_index: 0 });
    }
  });
});
