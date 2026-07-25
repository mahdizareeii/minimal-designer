import { z } from "zod";

import { AssetIdSchema, NodeIdSchema, type NodeId } from "./ids.js";
import {
  DesignNodeSchema,
  MetadataSchema,
  NodeStyleSchema,
  type DesignNode,
  type JsonValue,
  type Metadata,
} from "./model.js";

/**
 * Reserved metadata carried by the V1 compatibility projection for one V2
 * component instance. The browser, Chromium renderer, and deterministic
 * software renderer all consume the same resolved contract.
 */
export const COMPONENT_INSTANCE_PROJECTION_KEY = "__formaspec_component_projection_v1" as const;

export const ComponentProjectedNodeOverrideSchema = z.object({
  content: z.string().max(100_000).optional(),
  visible: z.boolean().optional(),
  icon_name: z.string().trim().min(1).max(160).optional(),
  asset_id: AssetIdSchema.optional(),
  accessibility_label: z.string().max(1_000).optional(),
  style: NodeStyleSchema.optional(),
}).strict();

export const ComponentInstanceProjectionSchema = z.object({
  schema_version: z.literal(1),
  node_overrides: z.record(NodeIdSchema, ComponentProjectedNodeOverrideSchema),
  slot_children: z.record(NodeIdSchema, z.array(NodeIdSchema).max(100)),
}).strict().superRefine((projection, context) => {
  if (Object.keys(projection.node_overrides).length > 500) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["node_overrides"],
      message: "A component projection may override at most 500 source nodes.",
    });
  }
  if (Object.keys(projection.slot_children).length > 50) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["slot_children"],
      message: "A component projection may populate at most 50 slot anchors.",
    });
  }
});

export type ComponentProjectedNodeOverride = z.infer<typeof ComponentProjectedNodeOverrideSchema>;
export type ComponentInstanceProjection = z.infer<typeof ComponentInstanceProjectionSchema>;

export function readComponentInstanceProjection(overrides: Metadata): ComponentInstanceProjection | null {
  const parsed = ComponentInstanceProjectionSchema.safeParse(overrides[COMPONENT_INSTANCE_PROJECTION_KEY]);
  return parsed.success ? parsed.data : null;
}

export function withComponentInstanceProjection(
  overrides: Metadata,
  projection: ComponentInstanceProjection | null,
): Metadata {
  const next = structuredClone(overrides);
  if (projection === null) delete next[COMPONENT_INSTANCE_PROJECTION_KEY];
  else next[COMPONENT_INSTANCE_PROJECTION_KEY] = structuredClone(
    ComponentInstanceProjectionSchema.parse(projection),
  ) as unknown as JsonValue;
  return MetadataSchema.parse(next);
}

export function projectedComponentNode(
  node: DesignNode,
  projection: ComponentInstanceProjection | null,
): DesignNode {
  const override = projection?.node_overrides[node.id];
  if (!override) return node;
  const candidate = structuredClone(node);
  if (override.visible !== undefined) candidate.visible = override.visible;
  if (override.style !== undefined) candidate.style = {
    ...candidate.style,
    ...structuredClone(override.style),
  };
  if (override.accessibility_label !== undefined) {
    if (candidate.type === "image") candidate.alt = override.accessibility_label;
    else if (candidate.type === "icon") candidate.label = override.accessibility_label;
    else candidate.metadata.accessible_label = override.accessibility_label;
  }
  if (override.content !== undefined && candidate.type === "text") candidate.content = override.content;
  if (override.icon_name !== undefined && candidate.type === "icon") candidate.icon_name = override.icon_name;
  if (override.asset_id !== undefined && candidate.type === "image") candidate.asset_id = override.asset_id;
  return DesignNodeSchema.parse(candidate);
}

export function projectedComponentSlotChildren(
  projection: ComponentInstanceProjection | null,
  nodeId: NodeId,
): readonly NodeId[] {
  return projection?.slot_children[nodeId] ?? [];
}
