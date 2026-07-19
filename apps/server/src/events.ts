export type DesignerEventType = "design.created" | "design.updated" | "asset.created" | "context.updated";

export interface DesignerEvent {
  id: number;
  type: DesignerEventType;
  actorId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

type Listener = (event: DesignerEvent) => void;

export class EventHub {
  #nextId = 1;
  readonly #listeners = new Map<string, Set<Listener>>();

  publishWorkspace(actorId: string, type: DesignerEventType, data: Record<string, unknown>): DesignerEvent {
    return this.publish(actorId, type, data, true);
  }

  publishActor(actorId: string, type: DesignerEventType, data: Record<string, unknown>): DesignerEvent {
    return this.publish(actorId, type, data, false);
  }

  private publish(actorId: string, type: DesignerEventType, data: Record<string, unknown>, workspace: boolean): DesignerEvent {
    const event: DesignerEvent = {
      id: this.#nextId++,
      type,
      actorId,
      timestamp: new Date().toISOString(),
      data,
    };
    if (workspace) {
      for (const listeners of this.#listeners.values()) {
        for (const listener of listeners) listener(event);
      }
    } else {
      for (const listener of this.#listeners.get(actorId) ?? []) listener(event);
    }
    return event;
  }

  subscribe(actorId: string, listener: Listener): () => void {
    const listeners = this.#listeners.get(actorId) ?? new Set<Listener>();
    listeners.add(listener);
    this.#listeners.set(actorId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(actorId);
    };
  }
}
