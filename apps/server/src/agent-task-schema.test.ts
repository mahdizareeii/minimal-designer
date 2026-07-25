import { describe, expect, it } from "vitest";

import { McpAgentTaskSelectionConfirmationSchema } from "./agent-task-schema.js";

describe("McpAgentTaskSelectionConfirmationSchema", () => {
  const confirmation = {
    source: "user_confirmed" as const,
    product_id: `product_${"a".repeat(32)}`,
    product_name: "P".repeat(255),
    design_id: `document_${"b".repeat(32)}`,
    design_name: "D".repeat(255),
    base_version: 1,
  };

  it("accepts Product and Design names at the persisted 255-character limit", () => {
    expect(McpAgentTaskSelectionConfirmationSchema.parse(confirmation)).toEqual(confirmation);
  });

  it("rejects Product and Design names beyond the persisted limit", () => {
    expect(McpAgentTaskSelectionConfirmationSchema.safeParse({
      ...confirmation,
      product_name: `${confirmation.product_name}P`,
    }).success).toBe(false);
    expect(McpAgentTaskSelectionConfirmationSchema.safeParse({
      ...confirmation,
      design_name: `${confirmation.design_name}D`,
    }).success).toBe(false);
  });
});
