import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArchiveProjectDialog, DashboardProjectCard } from "../components/Dashboard";
import type { DesignProjectSummary } from "../domain";
import { archiveDesign, archiveProduct, restoreProduct, type ProductSummary } from "../lib/api";
import { useDesignerStore } from "../store/designer-store";

const project: DesignProjectSummary = {
  id: "design_archive_web_001",
  name: "Customer portal",
  version: 7,
  revisionId: "revision_archive_web_001",
  updatedAt: "2026-07-22T09:30:00.000Z",
};

const archivedResponse = {
  id: project.id,
  productId: "product_archive_web_001",
  name: project.name,
  version: project.version,
  revisionId: project.revisionId!,
  status: "archived" as const,
  createdAt: "2026-07-20T08:00:00.000Z",
  updatedAt: project.updatedAt,
  archivedAt: "2026-07-22T10:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const noOp = () => undefined;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useDesignerStore.setState({
    projects: [],
    archivingProjectId: null,
    error: null,
    notice: null,
    offline: false,
  });
});

describe("confirmed project archival", () => {
  it("uses Product archive and restore CAS fields and unwraps Product detail responses", async () => {
    const product: ProductSummary = {
      id: "product_archive_web_001",
      name: "Courier operations",
      description: "",
      status: "active",
      ownerPrincipalId: "principal_local",
      defaultDesignSystemReleaseId: null,
      defaultLocale: "fa",
      defaultDirection: "rtl",
      locales: ["fa", "en"],
      canonicalSpecificationDesignId: project.id,
      designCount: 0,
      createdAt: "2026-07-20T08:00:00.000Z",
      updatedAt: "2026-07-22T10:00:00.000Z",
      archivedAt: null,
    };
    const archivedProduct = {
      ...product,
      status: "archived" as const,
      updatedAt: "2026-07-22T10:01:00.000Z",
      archivedAt: "2026-07-22T10:01:00.000Z",
    };
    const restoredProduct = {
      ...archivedProduct,
      status: "active" as const,
      updatedAt: "2026-07-22T10:02:00.000Z",
      archivedAt: null,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ product: archivedProduct, designs: [] }))
      .mockResolvedValueOnce(jsonResponse({ product: restoredProduct, designs: [] }));

    await expect(archiveProduct(product, "product_archive_request_0001")).resolves.toEqual(archivedProduct);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      expectedUpdatedAt: product.updatedAt,
      confirmationName: product.name,
      idempotencyKey: "product_archive_request_0001",
    });

    await expect(restoreProduct(archivedProduct, "product_restore_request_0001")).resolves.toEqual(restoredProduct);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      expectedUpdatedAt: archivedProduct.updatedAt,
      expectedArchivedAt: archivedProduct.archivedAt,
      idempotencyKey: "product_restore_request_0001",
    });
  });

  it("sends the exact archive command and strictly validates the direct server result", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(archivedResponse))
      .mockResolvedValueOnce(jsonResponse({ ...archivedResponse, unsupported: true }));

    await expect(archiveDesign(project.id, project.version, project.name, "archive_request_0001"))
      .resolves.toEqual(archivedResponse);
    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe(`/api/designs/${project.id}/archive`);
    expect(request?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      expectedVersion: project.version,
      idempotencyKey: "archive_request_0001",
      confirmationName: project.name,
    });

    await expect(archiveDesign(project.id, project.version, project.name, "archive_request_0002"))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("tracks the in-flight project and removes only that project after success", async () => {
    const retained: DesignProjectSummary = {
      id: "design_retained_web_001",
      name: "Retained project",
      version: 3,
      updatedAt: "2026-07-21T08:00:00.000Z",
    };
    useDesignerStore.setState({ projects: [project, retained], archivingProjectId: null });
    let resolveRequest: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveRequest = resolve; })));

    const pending = useDesignerStore.getState().archiveProject(project.id, project.name);
    expect(useDesignerStore.getState().archivingProjectId).toBe(project.id);
    resolveRequest?.(jsonResponse(archivedResponse));
    await pending;

    expect(useDesignerStore.getState().archivingProjectId).toBeNull();
    expect(useDesignerStore.getState().projects).toEqual([retained]);
    expect(useDesignerStore.getState().notice).toContain("Immutable history and assets remain retained");
  });

  it("retains the project and clears the busy state when the server rejects a stale version", async () => {
    useDesignerStore.setState({ projects: [project], archivingProjectId: null });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      error: {
        code: "VERSION_CONFLICT",
        message: "The project changed before deletion.",
        retryable: true,
      },
    }, 409)));

    await expect(useDesignerStore.getState().archiveProject(project.id, project.name))
      .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(useDesignerStore.getState()).toMatchObject({
      projects: [project],
      archivingProjectId: null,
      offline: false,
      error: "The project changed before deletion.",
    });
  });

  it("keeps Design archival disabled until the name matches exactly and explains retained records", () => {
    const mismatch = renderToStaticMarkup(
      <ArchiveProjectDialog
        project={project}
        confirmationName={`${project.name} `}
        archiving={false}
        error={null}
        onConfirmationNameChange={noOp}
        onClose={noOp}
        onConfirm={noOp}
      />,
    );
    expect(mismatch).toContain("Move “Customer portal” out of the active workspace");
    expect(mismatch).toContain("revision history and stored assets remain on your server");
    expect(mismatch).toContain("Archive Design");
    expect(mismatch).not.toContain("Delete project");
    expect(mismatch).toMatch(/class="button button-danger" type="button" disabled=""/);

    const exact = renderToStaticMarkup(
      <ArchiveProjectDialog
        project={project}
        confirmationName={project.name}
        archiving={false}
        error={null}
        onConfirmationNameChange={noOp}
        onClose={noOp}
        onConfirm={noOp}
      />,
    );
    expect(exact).toMatch(/class="button button-danger" type="button"><svg/);
    expect(exact).not.toMatch(/class="button button-danger" type="button" disabled=""/);
  });

  it("renders project-card actions as sibling buttons instead of nesting controls", () => {
    const markup = renderToStaticMarkup(
      <DashboardProjectCard
        project={project}
        thumbnailIndex={0}
        offline
        archiveDisabled={false}
        onOpen={noOp}
        onArchive={noOp}
      />,
    );
    const card = markup.match(/<article class="project-card">[\s\S]*?<\/article>/)?.[0];
    expect(card).toBeDefined();
    const openButton = card!.indexOf('class="project-card-open"');
    const openButtonEnd = card!.indexOf("</button>", openButton);
    const archiveButton = card!.indexOf('class="project-archive-action"');
    expect(openButton).toBeGreaterThan(-1);
    expect(openButtonEnd).toBeGreaterThan(openButton);
    expect(archiveButton).toBeGreaterThan(openButtonEnd);
    expect(card).toContain("Archive Design Customer portal");
  });
});
