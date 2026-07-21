import type { OrganizationRole } from "./authorization.js";

export type McpToolEffect = "read" | "preview" | "write" | "destructive";
export type McpProjectBoundary =
  | "none"
  | "filtered"
  | "required"
  | "optional"
  | "organization_only"
  | "unrestricted_grant_only"
  | "dynamic";

export type McpAgentAuthorization =
  | { mode: "authenticated" }
  | { mode: "denied" }
  | { mode: "all_scopes"; scopes: readonly string[] }
  | { mode: "dynamic"; scopes: Readonly<Record<string, string>> };

export interface McpAccessContract {
  agent: McpAgentAuthorization;
  humanRoles: readonly OrganizationRole[];
  projectBoundary: McpProjectBoundary;
  enforcement: readonly string[];
}

export interface McpToolContract extends McpAccessContract {
  effect: McpToolEffect;
  outputSchemaRequired: true;
}

export interface McpResourceContract extends McpAccessContract {
  uri: string;
  template: boolean;
}

const allHumanRoles = [
  "organization_admin",
  "product_manager",
  "design_editor",
  "engineer",
  "viewer",
] as const satisfies readonly OrganizationRole[];
const designWriters = ["organization_admin", "product_manager", "design_editor"] as const;
const productManagers = ["organization_admin", "product_manager"] as const;
const taskCreators = ["organization_admin", "product_manager", "design_editor"] as const;
const inventoryReaders = ["organization_admin", "product_manager", "design_editor", "engineer"] as const;
const inventoryWriters = ["organization_admin", "engineer"] as const;
const mappingWriters = ["organization_admin", "design_editor", "engineer"] as const;
const handoffWriters = ["organization_admin", "product_manager", "design_editor", "engineer"] as const;
const redesignWriters = ["organization_admin", "product_manager", "design_editor", "engineer"] as const;

const authenticated = { mode: "authenticated" } as const;
const denied = { mode: "denied" } as const;
const scopes = (...required: string[]) => ({ mode: "all_scopes", scopes: required } as const);
const tool = (
  effect: McpToolEffect,
  agent: McpAgentAuthorization,
  humanRoles: readonly OrganizationRole[],
  projectBoundary: McpProjectBoundary,
  ...enforcement: string[]
): McpToolContract => ({ effect, outputSchemaRequired: true, agent, humanRoles, projectBoundary, enforcement });
const resource = (
  uri: string,
  template: boolean,
  agent: McpAgentAuthorization,
  humanRoles: readonly OrganizationRole[],
  projectBoundary: McpProjectBoundary,
  ...enforcement: string[]
): McpResourceContract => ({ uri, template, agent, humanRoles, projectBoundary, enforcement });

/**
 * Executable inventory of every MCP tool. Tests compare this record with the
 * SDK's advertised surface, annotations, strict schemas, and authorization
 * probes so newly registered capabilities cannot silently bypass review.
 */
export const MCP_TOOL_CONTRACTS = {
  context_get: tool("read", scopes("design:read"), allHumanRoles, "filtered", "DesignerService.getContext"),
  organization_policy_read: tool("read", scopes("organization_policy:read"), allHumanRoles, "none", "OrganizationPolicyService.read"),
  design_list: tool("read", scopes("design:read"), allHumanRoles, "filtered", "DesignerService.listDesigns"),
  design_create: tool("write", scopes("design:write"), designWriters, "unrestricted_grant_only", "assertDesignWrite", "DesignerService.createDesign"),
  design_read: tool("read", scopes("design:read"), allHumanRoles, "required", "DesignerService.requireDesign"),
  node_search: tool("read", scopes("design:read"), allHumanRoles, "required", "DesignerService.getDesign"),
  design_preview_changes: tool("preview", scopes("design:preview", "design:read"), allHumanRoles, "required", "DesignerService.createPreview", "DesignerService.requireDesign"),
  design_preview_archive_nodes: tool("preview", scopes("design:preview", "design:read"), allHumanRoles, "required", "DesignerService.createPreview", "DesignerService.requireDesign"),
  design_render: tool("read", scopes("design:read"), allHumanRoles, "required", "DesignerService.getDesign/getPreview"),
  design_lint: tool("read", scopes("design:read"), allHumanRoles, "required", "DesignerService.getDesign/getPreview"),
  design_commit_preview: tool("write", scopes("design:write", "design:read"), designWriters, "required", "assertDesignWrite", "DesignerService.loadPreview"),
  design_commit_archive_preview: tool("destructive", scopes("design:write", "design:read"), designWriters, "required", "assertDesignWrite", "DesignerService.loadPreview"),
  design_history: tool("read", scopes("design:read"), allHumanRoles, "required", "DesignerService.history"),
  design_restore_revision: tool("write", scopes("design:write", "design:read"), designWriters, "required", "assertDesignWrite", "DesignerService.restoreRevision"),
  product_spec_read: tool("read", scopes("product_spec:read"), allHumanRoles, "required", "EnterpriseService.requireDesign"),
  product_spec_preview: tool("preview", scopes("product_spec:preview"), productManagers, "required", "EnterpriseService.previewProductSpecification"),
  product_spec_commit_preview: tool("write", scopes("product_spec:write"), productManagers, "required", "EnterpriseService.commitProductSpecificationPreview"),
  planning_session_list: tool("read", scopes("planning:read"), allHumanRoles, "required", "EnterpriseService.listPlanningSessions"),
  planning_session_create: tool("write", scopes("planning:write"), productManagers, "required", "EnterpriseService.createPlanningSession"),
  planning_session_read: tool("read", scopes("planning:read"), allHumanRoles, "required", "EnterpriseService.readPlanningSession"),
  planning_session_save_answer: tool("write", scopes("planning:write"), productManagers, "required", "EnterpriseService.savePlanningAnswer"),
  task_create: tool("write", scopes("task:create"), taskCreators, "required", "EnterpriseService.createAgentTask"),
  task_list: tool("read", scopes("task:read"), allHumanRoles, "filtered", "EnterpriseService.listAgentTasks"),
  task_read: tool("read", scopes("task:read"), allHumanRoles, "required", "EnterpriseService.readAgentTask"),
  task_claim: tool("write", scopes("task:claim"), [], "required", "EnterpriseService.claimAgentTask"),
  task_transition: tool("write", scopes("task:update"), taskCreators, "required", "EnterpriseService.transitionAgentTask"),
  design_system_read: tool("read", authenticated, allHumanRoles, "none", "authenticated MCP endpoint"),
  design_system_list: tool("read", scopes("design_system:read"), allHumanRoles, "none", "DesignSystemService.resolveReadAccess"),
  design_system_release_read: tool("read", scopes("design_system:read"), allHumanRoles, "none", "DesignSystemService.readRelease"),
  design_system_revision_release_read: tool("read", scopes("design_system:read"), allHumanRoles, "required", "DesignSystemService.readRevisionRelease"),
  design_system_project_pin_read: tool("read", scopes("design_system:read"), allHumanRoles, "required", "DesignSystemService.readProjectPin"),
  design_system_component_insert_preview: tool(
    "preview",
    scopes("design:preview", "design:read", "design_system:read"),
    allHumanRoles,
    "required",
    "ComponentInsertionService.preview",
    "DesignerService.createPreparedPreview",
  ),
  design_system_upgrade_preview: tool("preview", denied, ["organization_admin"], "required", "DesignSystemService.requireOrganizationAdmin"),
  design_system_upgrade_commit: tool("write", denied, ["organization_admin"], "required", "DesignSystemService.requireOrganizationAdmin"),
  repository_inventory_list: tool("read", scopes("workspace:inventory:read"), inventoryReaders, "organization_only", "WorkspaceHandoffService.listRepositoryInventories"),
  repository_inventory_persist: tool("write", scopes("workspace:inventory:write"), inventoryWriters, "organization_only", "WorkspaceHandoffService.persistRepositoryInventory"),
  repository_inventory_read: tool("read", scopes("workspace:inventory:read"), inventoryReaders, "organization_only", "WorkspaceHandoffService.readRepositoryInventory"),
  implementation_mapping_read: tool("read", scopes("implementation_mapping:read"), allHumanRoles, "required", "WorkspaceHandoffService.read/listImplementationMappings"),
  implementation_mapping_create: tool("write", scopes("implementation_mapping:write"), mappingWriters, "required", "WorkspaceHandoffService.createImplementationMappings"),
  handoff_list: tool("read", scopes("handoff:read"), allHumanRoles, "filtered", "WorkspaceHandoffService.listHandoffSummaries"),
  handoff_read: tool("read", scopes("handoff:read"), allHumanRoles, "required", "WorkspaceHandoffService.readHandoff"),
  handoff_execution_decisions_read: tool("read", scopes("handoff:read"), allHumanRoles, "required", "WorkspaceHandoffService.readHandoffExecutionDecisions"),
  handoff_execution_decision_record: tool("write", {
    mode: "dynamic",
    scopes: {
      plan_approval: "handoff:execution:plan",
      isolation_choice: "handoff:execution:isolation",
      diff_review: "handoff:execution:diff_review",
      validation_approval: "handoff:execution:validation",
      commit_approval: "handoff:execution:commit",
      push_authorization: "handoff:execution:push",
      pull_request_request: "handoff:execution:pull_request",
    },
  }, ["organization_admin", "product_manager", "engineer"], "required", "WorkspaceHandoffService.recordHandoffExecutionDecision", "handoff-execution-public.test.ts"),
  handoff_create: tool("write", denied, handoffWriters, "required", "WorkspaceHandoffService.createHandoff"),
  handoff_update: tool("write", denied, handoffWriters, "required", "WorkspaceHandoffService.updateHandoff"),
  handoff_submit_review: tool("write", denied, handoffWriters, "required", "WorkspaceHandoffService.submitHandoffForReview"),
  redesign_assessment_create: tool("write", scopes("redesign:assessment"), redesignWriters, "dynamic", "RedesignStudioService.createOneClickAssessment"),
  redesign_assessment_read: tool("read", scopes("redesign:read"), allHumanRoles, "dynamic", "RedesignStudioService.getAssessment"),
  redesign_stage_revise: tool("write", {
    mode: "dynamic",
    scopes: {
      connect_inspect: "redesign:review",
      document_current_state: "redesign:review",
      pm_interview: "redesign:interview",
      future_state_proposal: "redesign:proposal",
      design: "redesign:design",
      handoff: "redesign:handoff",
      approved_implementation: "redesign:implement",
    },
  }, redesignWriters, "dynamic", "RedesignStudioService.reviseCurrentStage", "redesign-studio-service.test.ts"),
  redesign_stage_artifact_read: tool("read", scopes("redesign:read"), allHumanRoles, "dynamic", "RedesignStudioService.getStageArtifact"),
  redesign_stage_artifact_write: tool("write", {
    mode: "dynamic",
    scopes: {
      connect_inspect: "redesign:review",
      document_current_state: "redesign:review",
      pm_interview: "redesign:interview",
      future_state_proposal: "redesign:proposal",
      design: "redesign:design",
      handoff: "redesign:handoff",
      approved_implementation: "redesign:implement",
    },
  }, redesignWriters, "dynamic", "RedesignStudioService.reviseStageArtifact", "redesign-studio-service.test.ts"),
  redesign_stage_transition: tool("write", {
    mode: "dynamic",
    scopes: {
      advanced_or_returned: "target-stage redesign scope",
      approved: "redesign:approve",
      completed: "redesign:implement",
      cancelled: "redesign:cancel",
    },
  }, redesignWriters, "dynamic", "RedesignStudioService.transition", "redesign-studio-service.test.ts"),
} as const satisfies Record<string, McpToolContract>;

/** Complete inventory of fixed resources and resource templates. */
export const MCP_RESOURCE_CONTRACTS = {
  "formaspec-schema-v1": resource("formaspec://schema/v1", false, authenticated, allHumanRoles, "none", "authenticated MCP endpoint"),
  "formaspec-schema-v2": resource("formaspec://schema/v2", false, authenticated, allHumanRoles, "none", "authenticated MCP endpoint"),
  "design-head": resource("formaspec://designs/{designId}/head", true, scopes("design:read"), allHumanRoles, "required", "DesignerService.getDesign"),
  "design-version": resource("formaspec://designs/{designId}/versions/{version}", true, scopes("design:read"), allHumanRoles, "required", "DesignerService.getDesign"),
  "design-node-subtree": resource("formaspec://designs/{designId}/versions/{version}/nodes/{nodeId}", true, scopes("design:read"), allHumanRoles, "required", "DesignerService.getDesign"),
  "design-tokens": resource("formaspec://designs/{designId}/versions/{version}/tokens", true, scopes("design:read"), allHumanRoles, "required", "DesignerService.getDesign"),
  "design-history": resource("formaspec://designs/{designId}/history", true, scopes("design:read"), allHumanRoles, "required", "DesignerService.history"),
  "product-specification": resource("formaspec://designs/{designId}/product-specification/{version}", true, scopes("product_spec:read"), allHumanRoles, "required", "EnterpriseService.readProductSpecification"),
  "product-specification-preview": resource("formaspec://designs/{designId}/product-specification/previews/{previewId}", true, scopes("product_spec:read"), allHumanRoles, "required", "EnterpriseService.readProductSpecificationPreview"),
  "planning-session": resource("formaspec://planning-sessions/{sessionId}", true, scopes("planning:read"), allHumanRoles, "required", "EnterpriseService.readPlanningSession"),
  "agent-task": resource("formaspec://tasks/{taskId}", true, scopes("task:read"), allHumanRoles, "required", "EnterpriseService.readAgentTask"),
  "design-system-release": resource("formaspec://design-system-releases/{releaseId}", true, scopes("design_system:read"), allHumanRoles, "none", "DesignSystemService.readRelease"),
  "design-system-revision-release": resource("formaspec://designs/{designId}/revisions/{revisionId}/design-system-release", true, scopes("design_system:read"), allHumanRoles, "required", "DesignSystemService.readRevisionRelease"),
  "design-system-project-pin": resource("formaspec://designs/{designId}/design-system-pin", true, scopes("design_system:read"), allHumanRoles, "required", "DesignSystemService.readProjectPin"),
  "design-system-upgrade-preview": resource("formaspec://design-system-upgrade-previews/{previewId}", true, scopes("design_system:read"), allHumanRoles, "required", "DesignSystemService.readUpgradePreview"),
  "repository-inventory": resource("formaspec://repository-inventories/{inventoryId}", true, scopes("workspace:inventory:read"), inventoryReaders, "organization_only", "WorkspaceHandoffService.readRepositoryInventory"),
  "implementation-mapping": resource("formaspec://implementation-mappings/{mappingId}", true, scopes("implementation_mapping:read"), allHumanRoles, "required", "WorkspaceHandoffService.readImplementationMapping"),
  "engineering-handoff": resource("formaspec://handoffs/{handoffId}", true, scopes("handoff:read"), allHumanRoles, "required", "WorkspaceHandoffService.readHandoff"),
  "handoff-execution-decisions": resource("formaspec://handoffs/{handoffId}/execution-decisions", true, scopes("handoff:read"), allHumanRoles, "required", "WorkspaceHandoffService.readHandoffExecutionDecisions"),
  "redesign-assessment": resource("formaspec://redesign-assessments/{assessmentId}", true, scopes("redesign:read"), allHumanRoles, "dynamic", "RedesignStudioService.getAssessment"),
  "redesign-stage-artifact": resource("formaspec://redesign-assessments/{assessmentId}/stages/{stage}/artifact", true, scopes("redesign:read"), allHumanRoles, "dynamic", "RedesignStudioService.getStageArtifact"),
  "organization-policy": resource("formaspec://organizations/current/policy", false, scopes("organization_policy:read"), allHumanRoles, "none", "OrganizationPolicyService.read"),
  "foundation-design-system": resource("formaspec://design-systems/foundation/1", false, authenticated, allHumanRoles, "none", "authenticated MCP endpoint"),
  "design-render": resource("formaspec://designs/{designId}/versions/{version}/render.png", true, scopes("design:read"), allHumanRoles, "required", "DesignerService.getDesign"),
  "preview-render": resource("formaspec://designs/{designId}/previews/{previewId}/render.png", true, scopes("design:read"), allHumanRoles, "required", "DesignerService.getPreview"),
} as const satisfies Record<string, McpResourceContract>;

export const MCP_AUTHORIZATION_RESIDUAL_ALLOWLIST = {} as const;
