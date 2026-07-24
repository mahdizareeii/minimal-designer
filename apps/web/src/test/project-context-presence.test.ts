import { createDesignPage, createStarterDocument } from "@designer/core";
import { describe, expect, it, vi } from "vitest";

import { committedReviewProjectContext } from "../components/PreviewReviewPage";
import { updateContext } from "../lib/api";
import {
  ProjectContextPresenceCoordinator,
  type ProjectContextPresencePublishInput,
} from "../lib/project-context-presence";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

class FakeDocumentTarget extends EventTarget {
  visibilityState = "visible";
  focused = true;

  hasFocus = () => this.focused;
}

class StorageHub {
  private readonly values = new Map<string, string>();
  private readonly targets = new Set<EventTarget>();

  connect(target: EventTarget) {
    this.targets.add(target);
    return {
      getItem: (key: string) => this.values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        this.values.set(key, value);
        this.broadcast(target, key, value);
      },
      removeItem: (key: string) => {
        this.values.delete(key);
        this.broadcast(target, key, null);
      },
    };
  }

  private broadcast(source: EventTarget, key: string, newValue: string | null): void {
    for (const target of this.targets) {
      if (target === source) continue;
      const event = new Event("storage");
      Object.defineProperties(event, {
        key: { value: key },
        newValue: { value: newValue },
      });
      target.dispatchEvent(event);
    }
  }
}

describe("project context presence", () => {
  it("sends the scoped client lease through the keepalive context API", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    try {
      await updateContext({
        designId: null,
        selectedNodeIds: [],
        clientContextId: "client_api_context_0001",
      });

      expect(fetch).toHaveBeenCalledWith("/api/context", expect.objectContaining({
        method: "PUT",
        keepalive: true,
        body: JSON.stringify({
          designId: null,
          selectedNodeIds: [],
          clientContextId: "client_api_context_0001",
        }),
      }));
    } finally {
      fetch.mockRestore();
    }
  });

  it("serializes rapid changes, deduplicates identical context, retries, and releases only its lease", async () => {
    const first = deferred();
    const calls: ProjectContextPresencePublishInput[] = [];
    let concurrent = 0;
    let maximumConcurrent = 0;
    const publish = vi.fn(async (input: ProjectContextPresencePublishInput) => {
      calls.push(input);
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      if (calls.length === 1) await first.promise;
      concurrent -= 1;
    });
    const coordinator = new ProjectContextPresenceCoordinator({
      publish,
      heartbeatMs: 0,
      storage: null,
      windowTarget: null,
      documentTarget: null,
      clientContextId: "client_serial_context_0001",
    });
    const token = Symbol("editor");
    const firstContext = { designId: "document_context_0001", pageId: "page_context_0001", selectedNodeIds: [] };
    const latestContext = { ...firstContext, selectedNodeIds: ["node_context_0001"] };

    coordinator.activate(token, firstContext);
    coordinator.activate(token, latestContext);
    expect(publish).toHaveBeenCalledTimes(1);
    first.resolve();
    await coordinator.waitForIdle();

    expect(calls).toEqual([
      { ...firstContext, clientContextId: "client_serial_context_0001" },
      { ...latestContext, clientContextId: "client_serial_context_0001" },
    ]);
    expect(maximumConcurrent).toBe(1);
    expect(coordinator.getSnapshot().status).toBe("synced");

    coordinator.activate(token, latestContext);
    await coordinator.waitForIdle();
    expect(publish).toHaveBeenCalledTimes(2);

    await coordinator.refresh();
    await coordinator.waitForIdle();
    expect(publish).toHaveBeenCalledTimes(3);

    coordinator.deactivate(token);
    await coordinator.waitForIdle();
    expect(publish).toHaveBeenCalledTimes(4);
    expect(calls.at(-1)).toEqual({
      designId: null,
      selectedNodeIds: [],
      clientContextId: "client_serial_context_0001",
    });
    expect(calls.filter((input) => input.designId === null).every((input) => Boolean(input.clientContextId))).toBe(true);
    expect(coordinator.getSnapshot().status).toBe("idle");

    coordinator.activate(token, latestContext);
    await coordinator.waitForIdle();
    expect(publish).toHaveBeenCalledTimes(5);
  });

  it("surfaces a failed publish and succeeds after an explicit retry", async () => {
    let attempt = 0;
    const coordinator = new ProjectContextPresenceCoordinator({
      heartbeatMs: 0,
      storage: null,
      windowTarget: null,
      documentTarget: null,
      publish: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("Context endpoint unavailable");
      },
    });
    coordinator.activate(Symbol("editor"), {
      designId: "document_context_retry",
      selectedNodeIds: [],
    });
    await coordinator.waitForIdle();
    expect(coordinator.getSnapshot()).toMatchObject({
      status: "error",
      error: "Context endpoint unavailable",
    });

    await coordinator.refresh();
    await coordinator.waitForIdle();
    expect(attempt).toBe(2);
    expect(coordinator.getSnapshot()).toMatchObject({ status: "synced", error: null });
  });

  it("falls back to valid stable opaque IDs when browser storage is unavailable and supplied IDs are invalid", async () => {
    const publish = vi.fn(async (_input: ProjectContextPresencePublishInput) => undefined);
    const coordinator = new ProjectContextPresenceCoordinator({
      publish,
      heartbeatMs: 0,
      windowTarget: null,
      documentTarget: null,
      tabId: "bad",
      clientContextId: "also-bad",
      storage: {
        getItem: () => { throw new Error("Storage denied"); },
        setItem: () => { throw new Error("Storage denied"); },
        removeItem: () => { throw new Error("Storage denied"); },
      },
    });

    coordinator.activate(Symbol("private-browser-tab"), {
      designId: "document_storage_fallback",
      selectedNodeIds: [],
    });
    await coordinator.waitForIdle();

    expect(publish).toHaveBeenCalledTimes(1);
    const firstClientContextId = publish.mock.calls[0]![0].clientContextId;
    expect(firstClientContextId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);

    await coordinator.refresh();
    await coordinator.waitForIdle();
    expect(publish.mock.calls[1]![0].clientContextId).toBe(firstClientContextId);
    expect(coordinator.getSnapshot().status).toBe("synced");
  });

  it("lets only the most recently focused tab refresh and heartbeat the shared actor context", async () => {
    const hub = new StorageHub();
    const firstWindow = new EventTarget();
    const secondWindow = new EventTarget();
    const firstDocument = new FakeDocumentTarget();
    const secondDocument = new FakeDocumentTarget();
    secondDocument.focused = false;
    secondDocument.visibilityState = "hidden";
    const firstTimers: Array<() => void> = [];
    const secondTimers: Array<() => void> = [];
    const firstPublish = vi.fn(async (_input: ProjectContextPresencePublishInput) => undefined);
    const secondPublish = vi.fn(async (_input: ProjectContextPresencePublishInput) => undefined);
    let now = 1_000;
    const first = new ProjectContextPresenceCoordinator({
      publish: firstPublish,
      heartbeatMs: 60_000,
      windowTarget: firstWindow,
      documentTarget: firstDocument,
      storage: hub.connect(firstWindow),
      tabId: "tab-first",
      clientContextId: "client_context_first_0001",
      now: () => now,
      setInterval: (handler) => { firstTimers.push(handler); return 1 as unknown as ReturnType<typeof setInterval>; },
      clearInterval: () => undefined,
    });
    const second = new ProjectContextPresenceCoordinator({
      publish: secondPublish,
      heartbeatMs: 60_000,
      windowTarget: secondWindow,
      documentTarget: secondDocument,
      storage: hub.connect(secondWindow),
      tabId: "tab-second",
      clientContextId: "client_context_second_0001",
      now: () => now,
      setInterval: (handler) => { secondTimers.push(handler); return 2 as unknown as ReturnType<typeof setInterval>; },
      clearInterval: () => undefined,
    });

    first.activate(Symbol("first"), { designId: "document_first", selectedNodeIds: [] });
    second.activate(Symbol("second"), { designId: "document_second", selectedNodeIds: [] });
    await Promise.all([first.waitForIdle(), second.waitForIdle()]);
    expect(firstPublish).toHaveBeenCalledTimes(1);
    expect(secondPublish).not.toHaveBeenCalled();
    expect(second.getSnapshot().status).toBe("standby");

    now += 60_000;
    firstDocument.visibilityState = "hidden";
    firstDocument.focused = false;
    firstDocument.dispatchEvent(new Event("visibilitychange"));
    await first.waitForIdle();
    expect(firstPublish).toHaveBeenCalledTimes(2);

    firstTimers[0]!();
    secondTimers[0]!();
    await Promise.all([first.waitForIdle(), second.waitForIdle()]);
    expect(firstPublish).toHaveBeenCalledTimes(3);
    expect(secondPublish).not.toHaveBeenCalled();

    secondDocument.visibilityState = "visible";
    secondDocument.focused = true;
    secondWindow.dispatchEvent(new Event("focus"));
    await Promise.all([first.waitForIdle(), second.waitForIdle()]);
    expect(secondPublish).toHaveBeenCalledTimes(1);
    expect(firstPublish).toHaveBeenCalledTimes(4);
    expect(firstPublish.mock.calls.at(-1)?.[0]).toEqual({
      designId: null,
      selectedNodeIds: [],
      clientContextId: "client_context_first_0001",
    });
    expect(first.getSnapshot().status).toBe("standby");

    now += 60_000;
    firstTimers[0]!();
    secondTimers[0]!();
    await Promise.all([first.waitForIdle(), second.waitForIdle()]);
    expect(firstPublish).toHaveBeenCalledTimes(4);
    expect(secondPublish).toHaveBeenCalledTimes(2);
  });

  it("releases an older tab lease only after its in-flight publish when a newer tab takes ownership", async () => {
    const hub = new StorageHub();
    const firstWindow = new EventTarget();
    const secondWindow = new EventTarget();
    const firstDocument = new FakeDocumentTarget();
    const secondDocument = new FakeDocumentTarget();
    secondDocument.focused = false;
    secondDocument.visibilityState = "hidden";
    const oldWrite = deferred();
    const leases = new Map<string, string>();
    const firstCalls: ProjectContextPresencePublishInput[] = [];
    const secondCalls: ProjectContextPresencePublishInput[] = [];
    const firstPublish = vi.fn(async (input: ProjectContextPresencePublishInput) => {
      firstCalls.push(input);
      if (input.designId === null) {
        leases.delete(input.clientContextId);
        return;
      }
      await oldWrite.promise;
      leases.set(input.clientContextId, input.designId);
    });
    const secondPublish = vi.fn(async (input: ProjectContextPresencePublishInput) => {
      secondCalls.push(input);
      if (input.designId === null) leases.delete(input.clientContextId);
      else leases.set(input.clientContextId, input.designId);
    });
    const first = new ProjectContextPresenceCoordinator({
      publish: firstPublish,
      heartbeatMs: 0,
      windowTarget: firstWindow,
      documentTarget: firstDocument,
      storage: hub.connect(firstWindow),
      tabId: "tab_race_first",
      clientContextId: "client_race_first_0001",
    });
    const second = new ProjectContextPresenceCoordinator({
      publish: secondPublish,
      heartbeatMs: 0,
      windowTarget: secondWindow,
      documentTarget: secondDocument,
      storage: hub.connect(secondWindow),
      tabId: "tab_race_second",
      clientContextId: "client_race_second_0001",
    });

    first.activate(Symbol("first"), { designId: "document_old_context", selectedNodeIds: [] });
    second.activate(Symbol("second"), { designId: "document_new_context", selectedNodeIds: [] });
    expect(firstPublish).toHaveBeenCalledTimes(1);
    expect(secondPublish).not.toHaveBeenCalled();

    secondDocument.focused = true;
    secondDocument.visibilityState = "visible";
    secondWindow.dispatchEvent(new Event("focus"));
    await second.waitForIdle();
    expect(leases).toEqual(new Map([["client_race_second_0001", "document_new_context"]]));

    oldWrite.resolve();
    await first.waitForIdle();

    expect(firstCalls).toEqual([
      {
        designId: "document_old_context",
        selectedNodeIds: [],
        clientContextId: "client_race_first_0001",
      },
      {
        designId: null,
        selectedNodeIds: [],
        clientContextId: "client_race_first_0001",
      },
    ]);
    expect(secondCalls).toEqual([{
      designId: "document_new_context",
      selectedNodeIds: [],
      clientContextId: "client_race_second_0001",
    }]);
    expect(leases).toEqual(new Map([["client_race_second_0001", "document_new_context"]]));
    expect(first.getSnapshot().status).toBe("standby");
  });

  it("uses keepalive-safe scoped releases on pagehide and final deactivation without a global clear", async () => {
    const hub = new StorageHub();
    const windowTarget = new EventTarget();
    const documentTarget = new FakeDocumentTarget();
    const calls: ProjectContextPresencePublishInput[] = [];
    const coordinator = new ProjectContextPresenceCoordinator({
      publish: async (input) => { calls.push(input); },
      heartbeatMs: 0,
      windowTarget,
      documentTarget,
      storage: hub.connect(windowTarget),
      tabId: "tab_release_context",
      clientContextId: "client_release_context_0001",
    });
    const token = Symbol("editor");
    const active = { designId: "document_release_context", selectedNodeIds: [] };

    coordinator.activate(token, active);
    await coordinator.waitForIdle();
    windowTarget.dispatchEvent(new Event("pagehide"));
    await coordinator.waitForIdle();
    expect(calls.at(-1)).toEqual({
      designId: null,
      selectedNodeIds: [],
      clientContextId: "client_release_context_0001",
    });

    await coordinator.refresh();
    await coordinator.waitForIdle();
    coordinator.deactivate(token);
    await coordinator.waitForIdle();

    const releases = calls.filter((input) => input.designId === null);
    expect(releases).toHaveLength(2);
    expect(releases.every((input) => input.clientContextId === "client_release_context_0001")).toBe(true);
    expect(calls.some((input) => input.designId === null && !input.clientContextId)).toBe(false);
    expect(coordinator.getSnapshot()).toEqual({ status: "idle", error: null, lastSyncedAt: null });
  });

  it("publishes review context only from the committed head and falls back from preview-only pages", () => {
    const head = createStarterDocument({ preset: "phone", name: "Committed review context" });
    const committedPageId = head.pages[0]!.id;
    const committedNodeId = head.pages[0]!.children[0]!;
    const previewOnlyPage = createDesignPage({ name: "Preview-only page" });

    expect(committedReviewProjectContext(
      head,
      [previewOnlyPage.id, committedPageId],
      [committedNodeId, "node_preview_only"],
    )).toEqual({
      designId: head.id,
      pageId: committedPageId,
      selectedNodeIds: [committedNodeId],
    });
  });
});
