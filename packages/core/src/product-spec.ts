import { z } from "zod";

import { NodeIdSchema, PageIdSchema, PrototypeLinkIdSchema } from "./ids.js";

const opaqueId = (prefix: string) => z.string().regex(
  new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9_-]{7,}$`),
  `Invalid ${prefix} id`,
);

export const ProductSpecificationIdSchema = opaqueId("spec");
export const ProductSpecificationItemIdSchema = z.string().regex(
  /^(goal|non_goal|audience|role|entity|flow|rule|permission|validation|state|integration|event|requirement|criterion|assumption|question)_[A-Za-z0-9][A-Za-z0-9_-]{7,}$/,
  "Invalid product specification item id",
);
export const PlanningSessionIdSchema = opaqueId("planning");
export const PlanningAnswerIdSchema = opaqueId("answer");
export const ComponentDefinitionIdSchema = opaqueId("component");
export const ImplementationTargetIdSchema = opaqueId("target");

export const SpecificationLinksSchema = z.object({
  page_ids: z.array(PageIdSchema).max(100).default([]),
  frame_ids: z.array(NodeIdSchema).max(100).default([]),
  node_ids: z.array(NodeIdSchema).max(500).default([]),
  component_definition_ids: z.array(ComponentDefinitionIdSchema).max(100).default([]),
  prototype_link_ids: z.array(PrototypeLinkIdSchema).max(100).default([]),
  implementation_target_ids: z.array(ImplementationTargetIdSchema).max(100).default([]),
}).strict();
export type SpecificationLinks = z.infer<typeof SpecificationLinksSchema>;

const commonItemShape = {
  id: ProductSpecificationItemIdSchema,
  title: z.string().trim().min(1).max(240),
  description: z.string().max(20_000).default(""),
  links: SpecificationLinksSchema.default({}),
};

export const TypedConditionSchema = z.object({
  subject: z.string().trim().min(1).max(240),
  operator: z.enum([
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "greater_than",
    "greater_than_or_equal",
    "less_than",
    "less_than_or_equal",
    "is_set",
    "is_not_set",
    "in",
    "not_in",
  ]),
  expected: z.union([
    z.string().max(4_000),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(z.union([z.string().max(1_000), z.number().finite(), z.boolean()])).max(100),
  ]).optional(),
}).strict();
export type TypedCondition = z.infer<typeof TypedConditionSchema>;

export const GoalSchema = z.object({
  ...commonItemShape,
  success_measure: z.string().max(4_000).optional(),
}).strict();

export const NonGoalSchema = z.object(commonItemShape).strict();

export const AudienceSchema = z.object({
  ...commonItemShape,
  needs: z.array(z.string().trim().min(1).max(2_000)).max(100).default([]),
}).strict();

export const ProductRoleSchema = z.object({
  ...commonItemShape,
  audience_ids: z.array(ProductSpecificationItemIdSchema).max(100).default([]),
  capabilities: z.array(z.string().trim().min(1).max(1_000)).max(200).default([]),
}).strict();

export const BusinessEntityFieldSchema = z.object({
  key: z.string().trim().min(1).max(160).regex(/^[A-Za-z][A-Za-z0-9_]*$/),
  label: z.string().trim().min(1).max(240),
  data_type: z.enum(["string", "number", "boolean", "date", "datetime", "id", "enum", "asset", "reference"]),
  required: z.boolean().default(false),
  sensitive: z.boolean().default(false),
  enum_values: z.array(z.string().trim().min(1).max(240)).max(100).optional(),
  references_entity_id: ProductSpecificationItemIdSchema.optional(),
}).strict().superRefine((field, context) => {
  if (field.data_type === "enum" && (!field.enum_values || field.enum_values.length === 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["enum_values"], message: "Enum fields require values" });
  }
  if (field.data_type === "reference" && !field.references_entity_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["references_entity_id"], message: "Reference fields require an entity" });
  }
});

export const BusinessEntitySchema = z.object({
  ...commonItemShape,
  fields: z.array(BusinessEntityFieldSchema).max(200).default([]),
}).strict();

export const ProductFlowStepSchema = z.object({
  id: z.string().regex(/^step_[A-Za-z0-9][A-Za-z0-9_-]{7,}$/),
  title: z.string().trim().min(1).max(240),
  actor_role_id: ProductSpecificationItemIdSchema.optional(),
  screen_state_id: ProductSpecificationItemIdSchema.optional(),
  conditions: z.array(TypedConditionSchema).max(50).default([]),
  outcome: z.string().max(4_000).optional(),
}).strict();

export const ProductFlowSchema = z.object({
  ...commonItemShape,
  role_ids: z.array(ProductSpecificationItemIdSchema).max(100).default([]),
  steps: z.array(ProductFlowStepSchema).min(1).max(200),
}).strict();

export const BusinessRuleSchema = z.object({
  ...commonItemShape,
  conditions: z.array(TypedConditionSchema).max(100).default([]),
  outcomes: z.array(z.string().trim().min(1).max(4_000)).min(1).max(100),
  priority: z.enum(["low", "normal", "high", "critical"]).default("normal"),
}).strict();

export const PermissionRuleSchema = z.object({
  ...commonItemShape,
  role_ids: z.array(ProductSpecificationItemIdSchema).min(1).max(100),
  action: z.string().trim().min(1).max(240),
  resource: z.string().trim().min(1).max(240),
  effect: z.enum(["allow", "deny"]),
  conditions: z.array(TypedConditionSchema).max(100).default([]),
  sensitive: z.boolean().default(false),
}).strict();

export const ValidationRuleSchema = z.object({
  ...commonItemShape,
  entity_id: ProductSpecificationItemIdSchema.optional(),
  field_key: z.string().trim().min(1).max(160).optional(),
  conditions: z.array(TypedConditionSchema).min(1).max(100),
  message: z.string().trim().min(1).max(2_000),
}).strict();

export const ScreenStateSchema = z.object({
  ...commonItemShape,
  state: z.enum(["default", "loading", "empty", "error", "permission_denied", "success", "offline", "custom"]),
  state_key: z.string().trim().min(1).max(160).optional(),
  primary_action: z.string().max(1_000).optional(),
}).strict().superRefine((state, context) => {
  if (state.state === "custom" && !state.state_key) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["state_key"], message: "Custom states require state_key" });
  }
});

export const IntegrationRequirementSchema = z.object({
  ...commonItemShape,
  system: z.string().trim().min(1).max(240),
  direction: z.enum(["inbound", "outbound", "bidirectional"]),
  data: z.array(z.string().trim().min(1).max(1_000)).max(100).default([]),
  constraints: z.array(z.string().trim().min(1).max(2_000)).max(100).default([]),
}).strict();

export const AnalyticsEventSchema = z.object({
  ...commonItemShape,
  event_key: z.string().trim().min(1).max(200).regex(/^[A-Za-z][A-Za-z0-9_.-]*$/),
  properties: z.array(z.string().trim().min(1).max(240)).max(100).default([]),
  success_metric: z.string().max(2_000).optional(),
}).strict();

export const RequirementSchema = z.object({
  ...commonItemShape,
  severity: z.enum(["must", "should", "may"]).default("must"),
}).strict();

export const AcceptanceCriterionSchema = z.object({
  ...commonItemShape,
  given: z.array(z.string().trim().min(1).max(2_000)).max(50).default([]),
  when: z.array(z.string().trim().min(1).max(2_000)).max(50).default([]),
  then: z.array(z.string().trim().min(1).max(2_000)).min(1).max(100),
}).strict();

export const AssumptionSchema = z.object({
  ...commonItemShape,
  status: z.enum(["unvalidated", "validated", "invalidated"]).default("unvalidated"),
}).strict();

export const OpenQuestionSchema = z.object({
  ...commonItemShape,
  status: z.enum(["open", "answered", "deferred"]).default("open"),
  answer: z.string().max(20_000).optional(),
}).strict();

export const ProductSpecificationSchema = z.object({
  id: ProductSpecificationIdSchema,
  version: z.number().int().positive(),
  natural_language_brief: z.string().max(100_000).default(""),
  summary: z.string().max(20_000).default(""),
  goals: z.array(GoalSchema).max(500).default([]),
  non_goals: z.array(NonGoalSchema).max(500).default([]),
  audiences: z.array(AudienceSchema).max(500).default([]),
  roles: z.array(ProductRoleSchema).max(500).default([]),
  entities: z.array(BusinessEntitySchema).max(500).default([]),
  flows: z.array(ProductFlowSchema).max(500).default([]),
  business_rules: z.array(BusinessRuleSchema).max(2_000).default([]),
  permissions: z.array(PermissionRuleSchema).max(2_000).default([]),
  validations: z.array(ValidationRuleSchema).max(2_000).default([]),
  screen_states: z.array(ScreenStateSchema).max(2_000).default([]),
  integrations: z.array(IntegrationRequirementSchema).max(500).default([]),
  analytics_events: z.array(AnalyticsEventSchema).max(2_000).default([]),
  accessibility_requirements: z.array(RequirementSchema).max(500).default([]),
  non_functional_requirements: z.array(RequirementSchema).max(500).default([]),
  acceptance_criteria: z.array(AcceptanceCriterionSchema).max(2_000).default([]),
  assumptions: z.array(AssumptionSchema).max(500).default([]),
  open_questions: z.array(OpenQuestionSchema).max(500).default([]),
}).strict().superRefine((specification, context) => {
  const ids = new Set<string>();
  for (const collection of [
    specification.goals,
    specification.non_goals,
    specification.audiences,
    specification.roles,
    specification.entities,
    specification.flows,
    specification.business_rules,
    specification.permissions,
    specification.validations,
    specification.screen_states,
    specification.integrations,
    specification.analytics_events,
    specification.accessibility_requirements,
    specification.non_functional_requirements,
    specification.acceptance_criteria,
    specification.assumptions,
    specification.open_questions,
  ]) {
    for (const item of collection) {
      if (ids.has(item.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate product specification item id: ${item.id}` });
      ids.add(item.id);
    }
  }
});
export type ProductSpecification = z.infer<typeof ProductSpecificationSchema>;

export const PlanningSectionSchema = z.enum([
  "product_purpose",
  "business_goals",
  "user_groups_and_roles",
  "primary_user_jobs",
  "important_flows",
  "target_platforms",
  "brand_requirements",
  "visual_personality",
  "languages_and_rtl",
  "business_entities",
  "permissions_and_sensitive_actions",
  "validation_rules",
  "loading_states",
  "empty_states",
  "error_states",
  "permission_denied_states",
  "accessibility_requirements",
  "analytics_and_success_metrics",
  "technical_constraints",
  "migration_constraints",
  "assumptions",
  "open_questions",
]);
export const PLANNING_SECTIONS = PlanningSectionSchema.options;

export const PlanningAnswerSchema = z.object({
  id: PlanningAnswerIdSchema,
  section: PlanningSectionSchema,
  version: z.number().int().positive(),
  answer: z.string().max(100_000),
  actor_id: z.string().trim().min(1).max(240),
  created_at: z.string().datetime({ offset: true }),
}).strict();

export const PlanningSessionSchema = z.object({
  id: PlanningSessionIdSchema,
  project_id: z.string().trim().min(1).max(240),
  version: z.number().int().positive(),
  status: z.enum(["draft", "in_progress", "ready_for_review", "completed", "cancelled"]),
  current_section: PlanningSectionSchema,
  answers: z.array(PlanningAnswerSchema).max(10_000),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
}).strict();
export type PlanningSession = z.infer<typeof PlanningSessionSchema>;
