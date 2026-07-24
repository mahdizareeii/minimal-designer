import { useEffect, useMemo, useSyncExternalStore } from "react";

import { updateContext } from "./api";

export interface ProjectContextPresenceInput {
  designId: string;
  pageId?: string;
  selectedNodeIds: string[];
}

export interface ProjectContextPresencePublishInput {
  designId: string | null;
  pageId?: string;
  selectedNodeIds: string[];
  clientContextId: string;
}

export type ProjectContextPresenceStatus = "idle" | "standby" | "syncing" | "synced" | "error";

export interface ProjectContextPresenceState {
  status: ProjectContextPresenceStatus;
  error: string | null;
  lastSyncedAt: string | null;
}

interface PresenceRegistration {
  input: ProjectContextPresenceInput;
  sequence: number;
}

interface PresenceEventTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

interface PresenceDocumentTarget extends PresenceEventTarget {
  visibilityState?: string;
  hasFocus?: () => boolean;
}

interface PresenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface ContextOwnerRecord {
  tabId: string;
  claimedAt: number;
}

type IntervalHandle = ReturnType<typeof globalThis.setInterval>;

export interface ProjectContextPresenceCoordinatorOptions {
  publish?: (input: ProjectContextPresencePublishInput) => Promise<void>;
  heartbeatMs?: number;
  windowTarget?: PresenceEventTarget | null;
  documentTarget?: PresenceDocumentTarget | null;
  storage?: PresenceStorage | null;
  ownerStorageKey?: string;
  tabId?: string;
  clientContextId?: string;
  now?: () => number;
  setInterval?: (handler: () => void, timeout: number) => IntervalHandle;
  clearInterval?: (handle: IntervalHandle) => void;
}

const IDLE_STATE: ProjectContextPresenceState = {
  status: "idle",
  error: null,
  lastSyncedAt: null,
};

const CLIENT_CONTEXT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function contextKey(input: ProjectContextPresenceInput): string {
  return JSON.stringify([
    input.designId,
    input.pageId ?? null,
    input.selectedNodeIds,
  ]);
}

function cloneInput(input: ProjectContextPresenceInput): ProjectContextPresenceInput {
  return {
    designId: input.designId,
    ...(input.pageId ? { pageId: input.pageId } : {}),
    selectedNodeIds: [...input.selectedNodeIds],
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "FormaSpec could not publish the active project context.";
}

function createOpaqueContextId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      const value = crypto.randomUUID();
      if (CLIENT_CONTEXT_ID_PATTERN.test(value)) return value;
    }
  } catch {
    // Some privacy-restricted browser contexts expose crypto but reject calls.
  }
  const random = `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  return `tab_${Date.now().toString(36)}_${random.slice(0, 48)}`;
}

function validOrFallbackContextId(value: string | undefined): string {
  return value && CLIENT_CONTEXT_ID_PATTERN.test(value) ? value : createOpaqueContextId();
}

function browserStorage(): PresenceStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function parseOwnerRecord(value: string | null): ContextOwnerRecord | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ContextOwnerRecord>;
    if (typeof parsed.tabId !== "string" || parsed.tabId.length === 0) return null;
    if (typeof parsed.claimedAt !== "number" || !Number.isFinite(parsed.claimedAt)) return null;
    return { tabId: parsed.tabId, claimedAt: parsed.claimedAt };
  } catch {
    return null;
  }
}

export class ProjectContextPresenceCoordinator {
  private readonly publish: (input: ProjectContextPresencePublishInput) => Promise<void>;
  private readonly heartbeatMs: number;
  private readonly windowTarget: PresenceEventTarget | null;
  private readonly documentTarget: PresenceDocumentTarget | null;
  private readonly ownerStorageKey: string;
  private readonly tabId: string;
  private readonly clientContextId: string;
  private readonly now: () => number;
  private readonly setIntervalFn: (handler: () => void, timeout: number) => IntervalHandle;
  private readonly clearIntervalFn: (handle: IntervalHandle) => void;
  private readonly registrations = new Map<symbol, PresenceRegistration>();
  private readonly listeners = new Set<() => void>();
  private readonly focusListener: EventListener = () => {
    this.claimOwnership();
    void this.requestPublish(true);
  };
  private readonly visibilityListener: EventListener = () => {
    if (this.isInteractiveTab()) this.claimOwnership();
    if (this.hasOwnership()) void this.requestPublish(true);
    else this.handleOwnershipLoss();
  };
  private readonly storageListener: EventListener = (event) => {
    const storageEvent = event as Event & { key?: string | null; newValue?: string | null };
    if (storageEvent.key !== this.ownerStorageKey) return;
    const owner = parseOwnerRecord(storageEvent.newValue ?? null);
    if (owner?.tabId === this.tabId) {
      void this.requestPublish(true);
      return;
    }
    this.handleOwnershipLoss();
    if (!owner && this.registrations.size > 0 && this.isInteractiveTab()) {
      this.claimOwnership();
      if (this.hasOwnership()) void this.requestPublish(true);
    }
  };
  private readonly pageHideListener: EventListener = () => this.relinquishOwnership();
  private state: ProjectContextPresenceState = IDLE_STATE;
  private desired: ProjectContextPresenceInput | null = null;
  private registrationSequence = 0;
  private lastPublishedKey: string | null = null;
  private pending = false;
  private forcePending = false;
  private releasePending = false;
  private releaseInFlight = false;
  private leaseMayExist = false;
  private drainPromise: Promise<void> | null = null;
  private heartbeatHandle: IntervalHandle | null = null;
  private storage: PresenceStorage | null;
  private storageAvailable: boolean;

  constructor(options: ProjectContextPresenceCoordinatorOptions = {}) {
    this.publish = options.publish ?? updateContext;
    this.heartbeatMs = options.heartbeatMs ?? 60_000;
    this.windowTarget = options.windowTarget === undefined
      ? (typeof window === "undefined" ? null : window)
      : options.windowTarget;
    this.documentTarget = options.documentTarget === undefined
      ? (typeof document === "undefined" ? null : document)
      : options.documentTarget;
    this.storage = options.storage === undefined ? browserStorage() : options.storage;
    this.storageAvailable = this.storage !== null;
    this.ownerStorageKey = options.ownerStorageKey ?? "formaspec.project-context-owner.v1";
    this.tabId = validOrFallbackContextId(options.tabId);
    this.clientContextId = validOrFallbackContextId(options.clientContextId ?? this.tabId);
    this.now = options.now ?? Date.now;
    this.setIntervalFn = options.setInterval ?? globalThis.setInterval.bind(globalThis);
    this.clearIntervalFn = options.clearInterval ?? globalThis.clearInterval.bind(globalThis);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ProjectContextPresenceState => this.state;

  activate(token: symbol, input: ProjectContextPresenceInput): void {
    const wasEmpty = this.registrations.size === 0;
    this.registrations.set(token, {
      input: cloneInput(input),
      sequence: ++this.registrationSequence,
    });
    if (wasEmpty) this.startRefreshEvents();
    this.selectDesiredContext();
  }

  deactivate(token: symbol): void {
    if (!this.registrations.delete(token)) return;
    if (this.registrations.size === 0) {
      this.stopRefreshEvents();
      this.desired = null;
      this.pending = false;
      this.forcePending = false;
      this.lastPublishedKey = null;
      this.relinquishOwnership();
      this.updateState(IDLE_STATE);
      return;
    }
    this.selectDesiredContext();
  }

  refresh = (): Promise<void> => {
    this.claimOwnership();
    return this.requestPublish(true);
  };

  async waitForIdle(): Promise<void> {
    while (this.drainPromise) await this.drainPromise;
  }

  private selectDesiredContext(): void {
    let selected: PresenceRegistration | null = null;
    for (const registration of this.registrations.values()) {
      if (!selected || registration.sequence > selected.sequence) selected = registration;
    }
    this.desired = selected ? cloneInput(selected.input) : null;
    if (this.canPublishCurrentTab()) void this.requestPublish(false);
    else this.updateState({ status: "standby", error: null });
  }

  private requestPublish(force: boolean): Promise<void> {
    if (!this.desired) return this.drainPromise ?? Promise.resolve();
    this.pending = true;
    this.forcePending ||= force;
    return this.ensureDrain();
  }

  private requestLeaseRelease(): Promise<void> {
    if (!this.leaseMayExist) return this.drainPromise ?? Promise.resolve();
    if (this.releasePending || this.releaseInFlight) return this.drainPromise ?? Promise.resolve();
    this.releasePending = true;
    return this.ensureDrain();
  }

  private ensureDrain(): Promise<void> {
    if (!this.drainPromise) {
      this.drainPromise = this.drain().finally(() => {
        this.drainPromise = null;
        if (this.releasePending || (this.pending && this.desired)) void this.ensureDrain();
      });
    }
    return this.drainPromise;
  }

  private async drain(): Promise<void> {
    while (this.releasePending || (this.pending && this.desired)) {
      if (this.releasePending) {
        this.releasePending = false;
        this.lastPublishedKey = null;
        this.releaseInFlight = true;
        try {
          await this.publish({
            designId: null,
            selectedNodeIds: [],
            clientContextId: this.clientContextId,
          });
          this.leaseMayExist = false;
        } catch {
          // A failed release is retried on a later ownership/heartbeat event. Do
          // not replace the visible standby/idle state with an unload error.
        } finally {
          this.releaseInFlight = false;
        }
        continue;
      }

      if (!this.desired) {
        this.pending = false;
        this.forcePending = false;
        continue;
      }
      const ownsContext = this.hasOwnership();
      if (this.storageAvailable && !ownsContext) {
        this.pending = false;
        this.forcePending = false;
        if (this.leaseMayExist) this.releasePending = true;
        this.updateState({ status: "standby", error: null });
        continue;
      }
      const input = cloneInput(this.desired);
      const key = contextKey(input);
      const force = this.forcePending;
      this.pending = false;
      this.forcePending = false;
      if (!force && key === this.lastPublishedKey) {
        this.updateState({ status: "synced", error: null });
        continue;
      }

      this.updateState({ status: "syncing", error: null });
      // A request can reach the server even if the browser later loses its
      // response. Mark the lease before awaiting so ownership loss queues a
      // release strictly after this write.
      this.leaseMayExist = true;
      try {
        await this.publish({
          ...input,
          clientContextId: this.clientContextId,
        });
        this.lastPublishedKey = key;
        const stillCurrent = this.desired !== null && contextKey(this.desired) === key;
        if (stillCurrent && !this.pending && !this.releasePending) {
          if (this.hasOwnership()) {
            this.updateState({
              status: "synced",
              error: null,
              lastSyncedAt: new Date().toISOString(),
            });
          } else {
            this.updateState({ status: "standby", error: null });
          }
        }
      } catch (cause) {
        const stillCurrent = this.desired !== null && contextKey(this.desired) === key;
        if (stillCurrent && !this.pending && !this.releasePending) {
          this.updateState(this.hasOwnership()
            ? { status: "error", error: errorMessage(cause) }
            : { status: "standby", error: null });
        }
      }

      if (!this.hasOwnership() && this.leaseMayExist) {
        this.pending = false;
        this.forcePending = false;
        this.releasePending = true;
        if (this.registrations.size > 0) this.updateState({ status: "standby", error: null });
      }
    }
  }

  private updateState(patch: Partial<ProjectContextPresenceState>): void {
    const next = { ...this.state, ...patch };
    if (next.status === this.state.status
      && next.error === this.state.error
      && next.lastSyncedAt === this.state.lastSyncedAt) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private startRefreshEvents(): void {
    this.windowTarget?.addEventListener("focus", this.focusListener);
    this.windowTarget?.addEventListener("storage", this.storageListener);
    this.windowTarget?.addEventListener("pagehide", this.pageHideListener);
    this.documentTarget?.addEventListener("visibilitychange", this.visibilityListener);
    if (this.heartbeatMs > 0) {
      this.heartbeatHandle = this.setIntervalFn(() => {
        if (!this.ensureHeartbeatOwnership()) {
          void this.requestLeaseRelease();
          return;
        }
        void this.requestPublish(true);
      }, this.heartbeatMs);
    }
  }

  private stopRefreshEvents(): void {
    this.windowTarget?.removeEventListener("focus", this.focusListener);
    this.windowTarget?.removeEventListener("storage", this.storageListener);
    this.windowTarget?.removeEventListener("pagehide", this.pageHideListener);
    this.documentTarget?.removeEventListener("visibilitychange", this.visibilityListener);
    if (this.heartbeatHandle !== null) this.clearIntervalFn(this.heartbeatHandle);
    this.heartbeatHandle = null;
  }

  private isInteractiveTab(): boolean {
    if (typeof this.documentTarget?.hasFocus === "function") return this.documentTarget.hasFocus();
    return this.documentTarget?.visibilityState !== "hidden";
  }

  private canPublishCurrentTab(): boolean {
    if (!this.storageAvailable) return true;
    if (this.hasOwnership()) return true;
    if (!this.isInteractiveTab()) return false;
    this.claimOwnership();
    return this.hasOwnership();
  }

  private ensureHeartbeatOwnership(): boolean {
    if (!this.storageAvailable) return true;
    const owner = this.readOwner();
    if (owner?.tabId === this.tabId) {
      this.writeOwner({ tabId: this.tabId, claimedAt: this.now() });
      return true;
    }
    const leaseMs = Math.max(this.heartbeatMs * 3, 180_000);
    if (!owner || this.now() - owner.claimedAt > leaseMs) {
      this.claimOwnership();
      return this.hasOwnership();
    }
    return false;
  }

  private hasOwnership(): boolean {
    if (!this.storageAvailable) return true;
    const owner = this.readOwner();
    return !this.storageAvailable || owner?.tabId === this.tabId;
  }

  private claimOwnership(): void {
    if (!this.storageAvailable) return;
    this.writeOwner({ tabId: this.tabId, claimedAt: this.now() });
  }

  private handleOwnershipLoss(): void {
    this.pending = false;
    this.forcePending = false;
    void this.requestLeaseRelease();
    if (this.registrations.size > 0) this.updateState({ status: "standby", error: null });
  }

  private relinquishOwnership(): void {
    this.pending = false;
    this.forcePending = false;
    void this.requestLeaseRelease();
    if (this.registrations.size > 0) this.updateState({ status: "standby", error: null });
    if (!this.storageAvailable || !this.hasOwnership()) return;
    try {
      this.storage?.removeItem(this.ownerStorageKey);
    } catch {
      this.disableStorageOwnership();
    }
  }

  private readOwner(): ContextOwnerRecord | null {
    if (!this.storageAvailable) return null;
    try {
      return parseOwnerRecord(this.storage?.getItem(this.ownerStorageKey) ?? null);
    } catch {
      this.disableStorageOwnership();
      return null;
    }
  }

  private writeOwner(owner: ContextOwnerRecord): void {
    if (!this.storageAvailable) return;
    try {
      this.storage?.setItem(this.ownerStorageKey, JSON.stringify(owner));
    } catch {
      this.disableStorageOwnership();
    }
  }

  private disableStorageOwnership(): void {
    this.storageAvailable = false;
    this.storage = null;
  }
}

export const projectContextPresenceCoordinator = new ProjectContextPresenceCoordinator();

export interface ProjectContextPresenceValue extends ProjectContextPresenceState {
  retry: () => void;
}

export function useProjectContextPresence(
  input: ProjectContextPresenceInput | null,
  coordinator = projectContextPresenceCoordinator,
): ProjectContextPresenceValue {
  const token = useMemo(() => Symbol("formaspec-project-context"), []);
  const key = input ? contextKey(input) : null;
  const normalized = useMemo(() => input ? cloneInput(input) : null, [key]);
  const state = useSyncExternalStore(
    coordinator.subscribe,
    coordinator.getSnapshot,
    coordinator.getSnapshot,
  );

  useEffect(() => {
    if (!normalized) return undefined;
    coordinator.activate(token, normalized);
    return () => coordinator.deactivate(token);
  }, [coordinator, normalized, token]);

  return {
    ...state,
    retry: () => { void coordinator.refresh(); },
  };
}
