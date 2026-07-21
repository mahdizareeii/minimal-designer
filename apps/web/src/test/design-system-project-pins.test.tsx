import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DesignSystemProjectPins,
  eligibleDesignSystemReleases,
  projectPinActionsDisabled,
} from "../components/DesignSystemProjectPins";
import {
  commitProjectDesignSystemUpgrade,
  listDesignSystemReleases,
  pinProjectDesignSystem,
  previewProjectDesignSystemUpgrade,
  readProjectDesignSystemPin,
  type DesignSystemReleaseRecord,
  type ProjectDesignSystemPinRecord,
} from "../lib/api";

const releases: DesignSystemReleaseRecord[] = [
  {
    id: "release_company0003",
    designSystemId: "system_company0001",
    version: 3,
    name: "Company 3",
    status: "published",
    tokenVersions: [],
    componentVersions: [],
    diagnostics: [],
    createdBy: "principal_admin",
    createdAt: "2026-07-20T08:00:00.000Z",
    publishedAt: "2026-07-20T08:00:00.000Z",
  },
  {
    id: "release_company0002",
    designSystemId: "system_company0001",
    version: 2,
    name: "Company 2",
    status: "deprecated",
    tokenVersions: [],
    componentVersions: [],
    diagnostics: [],
    createdBy: "principal_admin",
    createdAt: "2026-07-19T08:00:00.000Z",
    publishedAt: "2026-07-19T08:00:00.000Z",
  },
  {
    id: "release_company0001",
    designSystemId: "system_company0001",
    version: 1,
    name: "Company 1",
    status: "published",
    tokenVersions: [],
    componentVersions: [],
    diagnostics: [],
    createdBy: "principal_admin",
    createdAt: "2026-07-18T08:00:00.000Z",
    publishedAt: "2026-07-18T08:00:00.000Z",
  },
];

const pin: ProjectDesignSystemPinRecord = {
  designId: "document_companyproject01",
  designSystemId: "system_company0001",
  releaseId: "release_company0001",
  releaseVersion: 1,
  pinnedBy: "principal_admin",
  pinnedAt: "2026-07-20T09:00:00.000Z",
};

afterEach(() => vi.restoreAllMocks());

describe("project design-system pin and upgrade UI", () => {
  it("offers only newer published releases after a project is pinned", () => {
    expect(eligibleDesignSystemReleases(releases, null).map((release) => release.version)).toEqual([3, 1]);
    expect(eligibleDesignSystemReleases(releases, pin).map((release) => release.version)).toEqual([3]);
  });

  it("keeps project actions disabled while a switched project's pin or release catalog is unresolved", () => {
    expect(projectPinActionsDisabled({
      canAdminister: true,
      selectedTarget: releases[0]!,
      busy: null,
      pinLoading: true,
      releasesLoading: false,
    })).toBe(true);
    expect(projectPinActionsDisabled({
      canAdminister: true,
      selectedTarget: releases[0]!,
      busy: null,
      pinLoading: false,
      releasesLoading: true,
    })).toBe(true);
    expect(projectPinActionsDisabled({
      canAdminister: true,
      selectedTarget: releases[0]!,
      busy: null,
      pinLoading: false,
      releasesLoading: false,
    })).toBe(false);
  });

  it("renders a dedicated exact-preview workspace", () => {
    const html = renderToStaticMarkup(<DesignSystemProjectPins
      designSystems={[{
        id: "system_company0001",
        name: "Company system",
        description: "Shared tokens and components",
        status: "active",
        createdBy: "principal_admin",
        createdAt: "2026-07-20T08:00:00.000Z",
        updatedAt: "2026-07-20T08:00:00.000Z",
      }]}
      canAdminister
      onNotice={() => undefined}
      onError={() => undefined}
    />);
    expect(html).toContain("Project release pins");
    expect(html).toContain("exact diagnostic previews");
    expect(html).toContain("Loading project pins");
  });

  it("uses exact pin, preview, and commit endpoints with CAS-bound payloads", async () => {
    const preview = {
      id: "upgrade_companypreview01",
      designId: pin.designId,
      currentReleaseId: pin.releaseId,
      targetReleaseId: releases[0]!.id,
      designVersion: 7,
      designRevisionId: "revision_companyproject07",
      diagnostics: [],
      previewHash: "a".repeat(64),
      status: "ready" as const,
      canCommit: true,
      createdAt: "2026-07-20T10:00:00.000Z",
      expiresAt: "2026-07-20T10:15:00.000Z",
      committedAt: null,
    };
    const upgradedPin = { ...pin, releaseId: releases[0]!.id, releaseVersion: 3 };
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ releases }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ pin }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ pin }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ preview }), { status: 201, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ preview: { ...preview, status: "committed" }, pin: upgradedPin }), { status: 200, headers: { "content-type": "application/json" } }));

    await listDesignSystemReleases("system_company0001");
    await readProjectDesignSystemPin(pin.designId);
    await pinProjectDesignSystem({ designId: pin.designId, releaseId: pin.releaseId, expectedCurrentReleaseId: null });
    await previewProjectDesignSystemUpgrade({ designId: pin.designId, targetReleaseId: preview.targetReleaseId });
    await commitProjectDesignSystemUpgrade({ previewId: preview.id, expectedPreviewHash: preview.previewHash });

    expect(fetch.mock.calls[0]?.[0]).toBe("/api/design-systems/system_company0001/releases");
    expect(fetch.mock.calls[1]?.[0]).toBe(`/api/designs/${pin.designId}/design-system-pin`);
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toEqual({
      releaseId: pin.releaseId,
      expectedCurrentReleaseId: null,
    });
    expect(JSON.parse(String(fetch.mock.calls[3]?.[1]?.body))).toEqual({ targetReleaseId: preview.targetReleaseId });
    expect(JSON.parse(String(fetch.mock.calls[4]?.[1]?.body))).toEqual({ expectedPreviewHash: preview.previewHash });
  });
});
