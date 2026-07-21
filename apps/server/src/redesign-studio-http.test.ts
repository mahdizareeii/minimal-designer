import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createEmptyRedesignStageArtifact } from "@designer/core";
import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.promises.rm(directory, { recursive: true, force: true })));
});

async function application(): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-redesign-http-"));
  temporaryDirectories.push(root);
  const built = await buildApplication(loadConfig({
    APP_MODE: "local",
    HOST: "127.0.0.1",
    PORT: "4310",
    DATA_DIR: path.join(root, "data"),
    BACKUP_DIR: path.join(root, "backups"),
    DESIGNER_DATABASE_PATH: ":memory:",
    PUBLIC_BASE_URL: "http://127.0.0.1:4310",
    AUTH_MODE: "none",
    FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(built);
  await built.app.ready();
  return built;
}

function item(id: string, title: string) {
  return {
    id,
    title,
    description: `${title} reviewed evidence`,
    status: "reviewed",
    priority: "normal",
    evidence: [],
    linked_ids: [],
  };
}

describe("Redesign Studio artifact HTTP contract", () => {
  it("replaces the current stage artifact through one CAS revision and reads immutable history", async () => {
    const built = await application();
    const headers = { "x-designer-user": "local" };
    const designResponse = await built.app.inject({
      method: "POST",
      url: "/api/designs",
      headers,
      payload: { name: "Artifact route fixture", preset: "web", idempotencyKey: "redesign-http-design-0001" },
    });
    const design = designResponse.json<{ document: { id: string } }>();
    const assessmentResponse = await built.app.inject({
      method: "POST",
      url: "/api/redesign-assessments",
      headers,
      payload: {
        designId: design.document.id,
        expectedDesignVersion: 1,
        brief: "Inspect the bounded source without modifying it.",
      },
    });
    const assessment = assessmentResponse.json<{ assessment: { id: string; currentVersion: number } }>().assessment;
    const blockedTransition = await built.app.inject({
      method: "POST",
      url: `/api/redesign-assessments/${assessment.id}/transition`,
      headers,
      payload: {
        expectedVersion: assessment.currentVersion,
        expectedDesignVersion: 1,
        toStage: "document_current_state",
        decision: "advanced",
      },
    });
    expect(blockedTransition.statusCode).toBe(422);
    expect(blockedTransition.json<{ error: { code: string; details: { diagnostics: Array<{ code: string }> } } }>().error).toMatchObject({
      code: "VALIDATION_FAILED",
      details: {
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "REDESIGN_STAGE_OUTCOME_REQUIRED" }),
          expect.objectContaining({ code: "REDESIGN_STAGE_REVIEW_REQUIRED" }),
        ]),
      },
    });
    const artifact = {
      ...createEmptyRedesignStageArtifact("connect_inspect"),
      summary: "The selected design and inventory boundaries are verified.",
      review_status: "reviewed",
      inventory: [item("redesign_item_httpinventory1", "Current design inventory")],
      source_connections: [item("redesign_item_httpconnection", "Explicit design connection")],
      constraints: [item("redesign_item_httpconstraint", "No source mutation")],
    };

    const write = await built.app.inject({
      method: "PUT",
      url: `/api/redesign-assessments/${assessment.id}/stages/connect_inspect/artifact`,
      headers,
      payload: { expectedVersion: assessment.currentVersion, expectedDesignVersion: 1, artifact },
    });
    expect(write.statusCode).toBe(200);
    expect(write.json<{ assessment: { currentVersion: number; current: { artifact: unknown } } }>().assessment).toMatchObject({
      currentVersion: 2,
      current: { artifact },
    });

    const mismatched = await built.app.inject({
      method: "PUT",
      url: `/api/redesign-assessments/${assessment.id}/stages/connect_inspect/artifact`,
      headers,
      payload: {
        expectedVersion: 2,
        expectedDesignVersion: 1,
        artifact: createEmptyRedesignStageArtifact("document_current_state"),
      },
    });
    expect(mismatched.statusCode).toBe(422);
    expect(mismatched.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_FAILED");

    const transitioned = await built.app.inject({
      method: "POST",
      url: `/api/redesign-assessments/${assessment.id}/transition`,
      headers,
      payload: {
        expectedVersion: 2,
        expectedDesignVersion: 1,
        toStage: "document_current_state",
        decision: "advanced",
      },
    });
    expect(transitioned.statusCode).toBe(200);
    expect(transitioned.json<{ assessment: { currentVersion: number; currentStage: string } }>().assessment).toMatchObject({
      currentVersion: 3,
      currentStage: "document_current_state",
    });

    const read = await built.app.inject({
      method: "GET",
      url: `/api/redesign-assessments/${assessment.id}/stages/connect_inspect/artifact`,
      headers,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json<{ stageArtifact: { headVersion: number; current: unknown; versions: unknown[] } }>().stageArtifact).toMatchObject({
      headVersion: 3,
      current: { assessmentVersion: 2, artifact },
      versions: [
        { assessmentVersion: 1, artifact: { review_status: "draft" } },
        { assessmentVersion: 2, artifact },
      ],
    });

    const stale = await built.app.inject({
      method: "PUT",
      url: `/api/redesign-assessments/${assessment.id}/stages/connect_inspect/artifact`,
      headers,
      payload: { expectedVersion: 1, expectedDesignVersion: 1, artifact },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ error: { code: string } }>().error.code).toBe("VERSION_CONFLICT");

    const designHead = await built.app.inject({ method: "GET", url: `/api/designs/${design.document.id}`, headers });
    expect(designHead.json<{ version: number }>().version).toBe(1);
  });
});
