import { createTextNode } from "@designer/core";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Administration,
  agentConnectionDisplayName,
  codexPairingCommand,
  codexPairingLink,
  groupAgentConnections,
  managedBackupRestoreCommand,
} from "../components/Administration";
import { TextTypographyEditor } from "../components/InspectorPanel";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FormaSpec browser usability", () => {
  it("exposes portable import and managed recovery without a server-path input", () => {
    const markup = renderToStaticMarkup(<Administration />);

    expect(markup).toContain("FormaSpec Administration");
    expect(markup).toContain("Managed backups &amp; recovery");
    expect(markup).toContain("Load a full server backup");
    expect(markup).toContain("Import one editable project");
    expect(markup).toContain("Project import is different from full restore");
    expect(markup).toContain("never accepts or sends an arbitrary server filesystem path");
    expect(markup).toContain('type="file"');
    expect(markup).toContain(".formaspec.zip");
  });

  it("builds a restore command only from a bounded opaque backup ID", () => {
    const backupId = `backup_${"a".repeat(40)}`;
    expect(managedBackupRestoreCommand(backupId)).toBe(
      `formaspecctl backup restore --backup-id ${backupId} --yes`,
    );
    expect(() => managedBackupRestoreCommand("backup_short")).toThrow(/not safe/i);
    expect(() => managedBackupRestoreCommand("../backups/company.tar")).toThrow(/not safe/i);
    expect(() => managedBackupRestoreCommand("backup_valid; rm -rf data")).toThrow(/not safe/i);
  });

  it("builds the authenticated Codex fallback from only the issued one-time ticket", () => {
    const nonce = `fspair_${"n".repeat(43)}`;
    const connectionId = `connection_${"a".repeat(32)}`;
    const challenge = {
      nonce,
      expiresAt: "2099-01-01T00:00:00.000Z",
      connection: { id: connectionId },
    } as Parameters<typeof codexPairingCommand>[0];
    expect(codexPairingCommand(challenge)).toBe(
      `formaspecctl --yes agent connect codex --pairing-nonce ${nonce} --connection-id ${connectionId}`,
    );
    const pairingLink = new URL(codexPairingLink(challenge));
    expect(pairingLink.protocol).toBe("formaspec:");
    expect(pairingLink.hostname).toBe("connect-agent");
    expect(Object.fromEntries(pairingLink.searchParams)).toEqual({ connection: connectionId, nonce });
    expect(codexPairingLink(challenge)).not.toMatch(/bearer|token/i);
    expect(() => codexPairingCommand({ ...challenge, nonce: "fspair_short" })).toThrow(/not safe/i);
    expect(() => codexPairingCommand({
      ...challenge,
      connection: { ...challenge.connection, id: "connection_bad;open evil" },
    })).toThrow(/not safe/i);
  });

  it("presents current FormaSpec connections before collapsed immutable history", () => {
    const connection = (id: string, status: "active" | "pending" | "expired" | "revoked", displayName: string) => ({
      id,
      adapter: "codex" as const,
      displayName,
      status,
      scopes: ["task:claim"],
      projectIds: [],
      principalId: status === "active" ? "principal_codex" : null,
      expiresAt: "2099-01-01T00:00:00.000Z",
      lastUsedAt: null,
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: `2026-07-2${id.length}T00:00:00.000Z`,
    });
    const active = connection("connection_active", "active", "Codex — Minimal UI");
    const pending = connection("connection_pending", "pending", "Old Codex label");
    const revoked = connection("connection_revoked", "revoked", "Codex — Minimal UI");
    const expired = connection("connection_expired", "expired", "Codex — Minimal UI");
    const grouped = groupAgentConnections([revoked, pending, expired, active]);

    expect(grouped.current.map((item) => item.status)).toEqual(["active", "pending"]);
    expect(grouped.history.map((item) => item.status)).toEqual(["expired", "revoked"]);
    expect(agentConnectionDisplayName(active)).toBe("Codex — FormaSpec");
  });

  it("renders explicit Vazirmatn, Persian, and mixed-direction typography controls", () => {
    const text = createTextNode({
      name: "Persian title",
      content: "سلام Product team",
      direction: "auto",
      style: { typography: { font_family: "Vazirmatn", font_size: 18, font_weight: 600 } },
    });

    const markup = renderToStaticMarkup(<TextTypographyEditor node={text} updateNode={() => undefined} />);
    expect(markup).toContain("Persian / RTL ready");
    expect(markup).toContain('aria-label="Bundled font family presets"');
    expect(markup).toContain("Vazirmatn");
    expect(markup).toContain('lang="fa"');
    expect(markup).toContain('dir="rtl"');
    expect(markup).toContain("فارسی و عربی");
    expect(markup).toContain('aria-label="Text direction"');
    expect(markup).toContain("Automatic mixed direction");
    expect(markup).toContain('aria-label="Font family" value="Vazirmatn"');
  });

  it("keeps scrolling and readability rules scoped to application chrome", () => {
    const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    expect(styles).toMatch(/\.administration-shell\s*\{[^}]*height:\s*100%;[^}]*height:\s*100dvh;[^}]*overflow-y:\s*auto;/s);
    expect(styles).toMatch(/\.session-auth-shell\s*\{[^}]*height:\s*100%;[^}]*height:\s*100dvh;[^}]*overflow:\s*auto;/s);
    expect(styles).toMatch(/\.redesign-studio-shell\s*\{[^}]*height:\s*100%;[^}]*height:\s*100dvh;[^}]*overflow-y:\s*auto;/s);
    expect(styles).toMatch(/@media \(max-width: 980px\)[\s\S]*?\.administration-list\s*\{[^}]*max-height:\s*none;[^}]*overflow:\s*visible;/);
    expect(styles).toContain("Readable application chrome");
    expect(styles).toContain("These selectors intentionally exclude canvas and prototype document rendering");
    expect(styles).toMatch(/\.administration-shell :is\(p, small, label, code, span\)[^{]*\{[^}]*font-size:\s*12px !important;/);
    expect(styles).toMatch(/\.administration-shell :is\(button, input, select, textarea\)[^{]*\{[^}]*font-size:\s*13px !important;/);
    expect(styles).toContain(".typography-font-presets");
    expect(styles).toContain(".editor-shell :is(.editor-topbar, .left-sidebar, .right-sidebar, .editor-stage-tabs, .editor-statusbar)");
    expect(styles).toMatch(/\.editor-shell :is\(\.editor-topbar,[^{]+:is\(button, input, select, textarea\)[^{]*\{[^}]*font-size:\s*13px !important;/);
    expect(styles).toMatch(/\.editor-shell :is\(\.editor-topbar,[^{]+:is\(label, span, small, p, code\)[^{]*\{[^}]*font-size:\s*12px !important;/);
    expect(styles).toMatch(/:is\(\.dashboard-shell, \.redesign-studio-shell\) :is\(button, input, select, textarea\)[^{]*\{[^}]*font-size:\s*13px !important;/);
    expect(styles).toMatch(/:is\(\.dashboard-shell, \.redesign-studio-shell\) :is\(label, legend, span, small, p, code, li, summary\)[^{]*\{[^}]*font-size:\s*12px !important;/);
    expect(styles).toMatch(/:is\(\.dashboard-shell, \.redesign-studio-shell\) :is\(div, section, article, header, footer, nav, form, fieldset\)[^{]*\{[^}]*font-size:\s*12px !important;/);
    expect(styles).toMatch(/\.redesign-studio-shell :is\(h1, h2\)[^{]*\{[^}]*font-size:\s*16px !important;/);
    expect(styles).toMatch(/\.dashboard-shell \.hero-row h1 span\s*\{[^}]*font-size:\s*inherit !important;[^}]*line-height:\s*inherit;/);
    expect(styles).toMatch(/\.redesign-studio-shell \.redesign-stage-card > header > div > span\s*\{[^}]*font-size:\s*22px !important;[^}]*line-height:\s*1 !important;/);
    expect(styles).not.toContain(".canvas-viewport :is(button, input, select, textarea, label, span, small, p, code)");
    expect(styles).not.toContain(".designer-node :is(button, input, select, textarea, label, span, small, p, code)");
  });
});
