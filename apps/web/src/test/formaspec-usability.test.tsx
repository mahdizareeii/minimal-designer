import { createTextNode } from "@designer/core";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Administration, codexPairingCommand, managedBackupRestoreCommand } from "../components/Administration";
import { TextTypographyEditor } from "../components/InspectorPanel";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FormaSpec browser usability", () => {
  it("exposes portable import and managed recovery without a server-path input", () => {
    const markup = renderToStaticMarkup(<Administration />);

    expect(markup).toContain("FormaSpec Administration");
    expect(markup).toContain("Managed backups &amp; recovery");
    expect(markup).toContain("Import &amp; project recovery");
    expect(markup).toContain("File-picker only");
    expect(markup).toContain("never accepts or sends an arbitrary server filesystem path");
    expect(markup).toContain('type="file"');
    expect(markup).toContain(".formaspec.zip");
  });

  it("builds a restore command only from a bounded opaque backup ID", () => {
    const backupId = `backup_${"a".repeat(40)}`;
    expect(managedBackupRestoreCommand(backupId)).toBe(
      `pnpm formaspecctl backup restore --backup-id ${backupId} --yes`,
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
      `./designer --yes agent connect codex --pairing-nonce ${nonce} --connection-id ${connectionId}`,
    );
    expect(() => codexPairingCommand({ ...challenge, nonce: "fspair_short" })).toThrow(/not safe/i);
    expect(() => codexPairingCommand({
      ...challenge,
      connection: { ...challenge.connection, id: "connection_bad;open evil" },
    })).toThrow(/not safe/i);
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
    expect(styles).toMatch(/\.administration-shell\s*\{[^}]*height:\s*100%;[^}]*overflow-y:\s*auto;/s);
    expect(styles).toContain("Readable application chrome");
    expect(styles).toContain("These selectors intentionally exclude canvas and prototype document rendering");
    expect(styles).toContain(".typography-font-presets");
    expect(styles).toContain(".editor-shell :is(.editor-topbar, .left-sidebar, .right-sidebar, .editor-stage-tabs, .editor-statusbar)");
  });
});
