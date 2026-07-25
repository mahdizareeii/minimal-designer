import type Database from "better-sqlite3";

export const DESIGNER_EVENT_TYPES = [
  "design.created",
  "design.updated",
  "product.updated",
  "asset.created",
  "context.updated",
  "product_spec.preview.updated",
  "product_spec.committed",
  "planning_session.updated",
  "agent_task.transitioned",
  "agent_connection.changed",
  "organization_policy.changed",
  "design_system.changed",
  "repository_inventory.changed",
  "implementation_mapping.changed",
  "handoff.transitioned",
  "redesign.transitioned",
  "backup.operation",
  "audit.retention",
  "events.gap",
] as const;

export type DesignerEventType = (typeof DESIGNER_EVENT_TYPES)[number];

export interface DesignerEvent {
  id: number;
  type: DesignerEventType;
  actorId: string;
  organizationId?: string;
  designId?: string;
  timestamp: string;
  data: Record<string, unknown>;
}

type Listener = (event: DesignerEvent) => void;

interface ListenerRegistration {
  listener: Listener;
  organizationId?: string;
  projectIds?: string[];
}

export class EventHub {
  #nextId = 1;
  readonly #listeners = new Map<string, Set<ListenerRegistration>>();

  publishWorkspace(actorId: string, type: DesignerEventType, data: Record<string, unknown>): DesignerEvent {
    return this.publish(actorId, type, data, true);
  }

  publishActor(actorId: string, type: DesignerEventType, data: Record<string, unknown>): DesignerEvent {
    return this.publish(actorId, type, data, false);
  }

  publishPersisted(event: DesignerEvent, workspace: boolean): DesignerEvent {
    this.#nextId = Math.max(this.#nextId, event.id + 1);
    this.deliver(event, workspace);
    return event;
  }

  private publish(actorId: string, type: DesignerEventType, data: Record<string, unknown>, workspace: boolean): DesignerEvent {
    const event: DesignerEvent = {
      id: this.#nextId++,
      type,
      actorId,
      timestamp: new Date().toISOString(),
      data,
    };
    this.deliver(event, workspace);
    return event;
  }

  private deliver(event: DesignerEvent, workspace: boolean): void {
    if (workspace) {
      for (const listeners of this.#listeners.values()) {
        for (const registration of listeners) {
          if (registration.organizationId && event.organizationId && registration.organizationId !== event.organizationId) continue;
          if (registration.projectIds?.length && (!event.designId || !registration.projectIds.includes(event.designId))) continue;
          try {
            registration.listener(event);
          } catch {
            // A disconnected or faulty listener must never change commit semantics.
          }
        }
      }
    } else {
      for (const registration of this.#listeners.get(event.actorId) ?? []) {
        if (registration.organizationId && event.organizationId && registration.organizationId !== event.organizationId) continue;
        if (registration.projectIds?.length && (!event.designId || !registration.projectIds.includes(event.designId))) continue;
        try {
          registration.listener(event);
        } catch {
          // Delivery is best-effort; persisted events remain authoritative.
        }
      }
    }
  }

  subscribe(actorId: string, listener: Listener, organizationId?: string, projectIds?: string[]): () => void {
    const listeners = this.#listeners.get(actorId) ?? new Set<ListenerRegistration>();
    const registration: ListenerRegistration = {
      listener,
      ...(organizationId ? { organizationId } : {}),
      ...(projectIds?.length ? { projectIds: [...projectIds] } : {}),
    };
    listeners.add(registration);
    this.#listeners.set(actorId, listeners);
    return () => {
      listeners.delete(registration);
      if (listeners.size === 0) this.#listeners.delete(actorId);
    };
  }
}

export function flushPersistedEventOutbox(sqlite: Database.Database, events: EventHub): void {
  while (true) {
    const rows = sqlite.prepare(
      `SELECT id, organization_id, actor_id, event_type, payload_json, workspace, created_at
       FROM event_outbox WHERE published_at IS NULL ORDER BY id LIMIT 100`,
    ).all() as Array<{
      id: number;
      organization_id: string;
      actor_id: string;
      event_type: DesignerEventType;
      payload_json: string;
      workspace: 0 | 1;
      created_at: string;
    }>;
    if (rows.length === 0) return;
    for (const row of rows) {
      const parsed = JSON.parse(row.payload_json) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Persisted event outbox row ${row.id} has an invalid payload.`);
      }
      const data = parsed as Record<string, unknown>;
      const designId = typeof data.designId === "string" ? data.designId : undefined;
      events.publishPersisted({
        id: row.id,
        type: row.event_type,
        actorId: row.actor_id,
        organizationId: row.organization_id,
        ...(designId ? { designId } : {}),
        timestamp: row.created_at,
        data,
      }, row.workspace === 1);
      sqlite.prepare(
        "UPDATE event_outbox SET published_at = ? WHERE id = ? AND published_at IS NULL",
      ).run(new Date().toISOString(), row.id);
    }
  }
}
