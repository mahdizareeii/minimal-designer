import { afterEach, describe, expect, it, vi } from "vitest";

import { subscribeToEvents } from "../lib/api";

describe("server event subscription", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("subscribes to persisted backup operation events by their SSE event name", () => {
    const eventTypes: string[] = [];
    let closed = false;
    let sourceUrl = "";
    class TestEventSource {
      onmessage: ((event: MessageEvent<string>) => void) | null = null;

      constructor(readonly url: string) {
        sourceUrl = url;
      }

      addEventListener(type: string): void {
        eventTypes.push(type);
      }

      close(): void {
        closed = true;
      }
    }
    vi.stubGlobal("EventSource", TestEventSource);

    const unsubscribe = subscribeToEvents(() => undefined);
    expect(sourceUrl).toBe("/api/events");
    expect(eventTypes).toContain("backup.operation");
    expect(eventTypes).toContain("audit.retention");
    unsubscribe();
    expect(closed).toBe(true);
  });
});
