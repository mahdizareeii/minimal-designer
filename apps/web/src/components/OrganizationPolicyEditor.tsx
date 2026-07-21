import {
  AlertTriangle,
  Braces,
  CheckCircle2,
  Download,
  LoaderCircle,
  Plus,
  RotateCcw,
  Save,
  Settings2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  organizationConfigurationUrl,
  type OrganizationPolicyRecord,
} from "../lib/api";
import {
  ORGANIZATION_AGENT_ADAPTERS,
  ORGANIZATION_AGENT_SCOPES,
  ORGANIZATION_ASSET_MIME_TYPES,
  ORGANIZATION_FRAME_PRESETS,
  ORGANIZATION_HUMAN_ROLES,
  ORGANIZATION_IDENTITY_CLAIMS,
  ORGANIZATION_REPOSITORY_PLATFORMS,
  ORGANIZATION_TOKEN_EXPORT_FORMATS,
  backupScheduleToTime,
  cloneOrganizationPolicy,
  formatPolicyLines,
  parseExpertOrganizationPolicyJson,
  parsePolicyLines,
  replaceOrganizationPolicySection,
  timeToBackupSchedule,
  togglePolicyListValue,
  validateOrganizationPolicyDraft,
  type OrganizationAgentScope,
  type OrganizationHumanRole,
  type OrganizationIdentityClaim,
  type OrganizationPolicy,
  type OrganizationPolicySectionKey,
} from "../lib/organization-policy";

type EditorMode = "guided" | "json";

interface OrganizationPolicyEditorProps {
  record: OrganizationPolicyRecord | null;
  loading: boolean;
  disabled: boolean;
  saving: boolean;
  onSave: (
    expectedConfigurationHash: string,
    policy: OrganizationPolicy | Record<string, unknown>,
  ) => Promise<void>;
  onError: (message: string) => void;
}

interface PolicySectionProps {
  title: string;
  description: string;
  wide?: boolean;
  children: ReactNode;
}

interface PolicyToggleProps {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

interface PolicyNumberFieldProps {
  label: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}

interface PolicyLineListProps {
  label: string;
  description: string;
  value: readonly string[];
  placeholder?: string;
  splitCommas?: boolean;
  disabled?: boolean;
  onChange: (value: string[]) => void;
}

interface PolicyChoiceSetProps<T extends string> {
  label: string;
  description: string;
  values: readonly T[];
  options: readonly T[];
  disabled?: boolean;
  formatLabel?: (value: T) => string;
  onChange: (values: T[]) => void;
}

function humanize(value: string): string {
  if (value === "ios") return "iOS";
  if (value === "dtcg") return "DTCG";
  if (value === "css") return "CSS";
  if (value === "ltr" || value === "rtl") return value.toUpperCase();
  if (value === "generic_mcp") return "Generic MCP";
  if (value === "typescript") return "TypeScript";
  return value
    .replaceAll(":", " · ")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function PolicySection({ title, description, wide = false, children }: PolicySectionProps) {
  return <section className={`organization-policy-section ${wide ? "is-wide" : ""}`}>
    <header><div><h3>{title}</h3><small>{description}</small></div></header>
    <div className="organization-policy-section-body">{children}</div>
  </section>;
}

function PolicyToggle({ label, description, checked, disabled = false, onChange }: PolicyToggleProps) {
  return <label className={`organization-policy-toggle ${disabled ? "is-locked" : ""}`}>
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.checked)}
    />
    <span><strong>{label}</strong><small>{description}</small></span>
  </label>;
}

function PolicyNumberField({
  label,
  description,
  value,
  min,
  max,
  step = 1,
  suffix,
  disabled = false,
  onChange,
}: PolicyNumberFieldProps) {
  return <label className="organization-policy-field">
    <span>{label}</span>
    <div className="organization-policy-number-input">
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      {suffix && <small>{suffix}</small>}
    </div>
    {description && <small>{description}</small>}
  </label>;
}

function PolicyLineList({
  label,
  description,
  value,
  placeholder,
  splitCommas = false,
  disabled = false,
  onChange,
}: PolicyLineListProps) {
  const formattedValue = formatPolicyLines(value);
  const [text, setText] = useState(formattedValue);
  useEffect(() => { setText(formattedValue); }, [formattedValue]);

  return <label className="organization-policy-field is-wide">
    <span>{label}</span>
    <textarea
      value={text}
      placeholder={placeholder}
      spellCheck={false}
      disabled={disabled}
      onChange={(event) => {
        const nextText = event.currentTarget.value;
        setText(nextText);
        onChange(parsePolicyLines(nextText, splitCommas));
      }}
      onBlur={() => setText(formatPolicyLines(parsePolicyLines(text, splitCommas)))}
    />
    <small>{description}</small>
  </label>;
}

function PolicyChoiceSet<T extends string>({
  label,
  description,
  values,
  options,
  disabled = false,
  formatLabel = humanize,
  onChange,
}: PolicyChoiceSetProps<T>) {
  return <fieldset className="organization-policy-choice-set">
    <legend>{label}</legend>
    <small>{description}</small>
    <div>
      {options.map((option) => <label key={option}>
        <input
          type="checkbox"
          checked={values.includes(option)}
          disabled={disabled}
          onChange={(event) => onChange(togglePolicyListValue(values, option, event.currentTarget.checked))}
        />
        <span>{formatLabel(option)}</span>
      </label>)}
    </div>
  </fieldset>;
}

function PolicySelect<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  return <label className="organization-policy-field">
    <span>{label}</span>
    <select value={value} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value as T)}>
      {options.map((option) => <option value={option} key={option}>{humanize(option)}</option>)}
    </select>
  </label>;
}

function FixedSecurityRule({ label, description }: { label: string; description: string }) {
  return <div className="organization-policy-fixed-rule">
    <ShieldCheck size={14} />
    <span><strong>{label}</strong><small>{description}</small></span>
  </div>;
}

const agentScopeGroups = [
  {
    title: "Design and context",
    scopes: ORGANIZATION_AGENT_SCOPES.filter((scope) => ["organization_policy", "context", "design"].some((prefix) => scope.startsWith(`${prefix}:`))),
  },
  {
    title: "Product planning and tasks",
    scopes: ORGANIZATION_AGENT_SCOPES.filter((scope) => ["product_spec", "planning", "task"].some((prefix) => scope.startsWith(`${prefix}:`))),
  },
  {
    title: "Systems and workspace bridge",
    scopes: ORGANIZATION_AGENT_SCOPES.filter((scope) => ["design_system", "workspace", "implementation_mapping"].some((prefix) => scope.startsWith(`${prefix}:`))),
  },
  {
    title: "Engineering handoff",
    scopes: ORGANIZATION_AGENT_SCOPES.filter((scope) => scope.startsWith("handoff:")),
  },
  {
    title: "Redesign Studio",
    scopes: ORGANIZATION_AGENT_SCOPES.filter((scope) => scope.startsWith("redesign:")),
  },
] as const;

export function OrganizationPolicyEditor({
  record,
  loading,
  disabled,
  saving,
  onSave,
  onError,
}: OrganizationPolicyEditorProps) {
  const [mode, setMode] = useState<EditorMode>("guided");
  const [draft, setDraft] = useState<OrganizationPolicy | null>(() => record ? cloneOrganizationPolicy(record.policy) : null);
  const [rawText, setRawText] = useState(() => record ? JSON.stringify(record.policy, null, 2) : "");

  useEffect(() => {
    if (!record) {
      setDraft(null);
      setRawText("");
      return;
    }
    setDraft(cloneOrganizationPolicy(record.policy));
    setRawText(JSON.stringify(record.policy, null, 2));
  }, [record]);

  const baselineText = useMemo(() => record ? JSON.stringify(record.policy, null, 2) : "", [record]);
  const draftText = useMemo(() => draft ? JSON.stringify(draft, null, 2) : "", [draft]);
  const validationIssues = useMemo(() => draft ? validateOrganizationPolicyDraft(draft) : [], [draft]);
  const dirty = mode === "guided" ? draftText !== baselineText : rawText !== baselineText;

  function replaceSection<K extends OrganizationPolicySectionKey>(
    section: K,
    value: OrganizationPolicy[K],
  ): void {
    setDraft((current) => current ? replaceOrganizationPolicySection(current, section, value) : current);
  }

  function updateRoleMapping(
    index: number,
    patch: Partial<OrganizationPolicy["identity"]["roleMappings"][number]>,
  ): void {
    if (!draft) return;
    const roleMappings = draft.identity.roleMappings.map((mapping, mappingIndex) => (
      mappingIndex === index ? { ...mapping, ...patch } : mapping
    ));
    replaceSection("identity", { roleMappings });
  }

  function selectMode(nextMode: EditorMode): void {
    if (nextMode === mode || !draft) return;
    if (nextMode === "guided" && rawText !== draftText) {
      const confirmed = window.confirm("Discard unsaved Expert JSON changes and return to the guided policy form?");
      if (!confirmed) return;
    }
    if (nextMode === "json") setRawText(draftText);
    if (nextMode === "guided") setRawText(draftText);
    setMode(nextMode);
  }

  async function savePolicy(): Promise<void> {
    if (!record || !draft) return;
    let policy: OrganizationPolicy | Record<string, unknown>;
    if (mode === "guided") {
      if (validationIssues.length > 0) {
        onError(`Policy needs attention: ${validationIssues[0]}`);
        return;
      }
      policy = draft;
    } else {
      const parsed = parseExpertOrganizationPolicyJson(rawText);
      if (!parsed.ok) {
        onError(parsed.message);
        return;
      }
      policy = parsed.policy;
    }
    const confirmed = window.confirm("Save this organization policy? Existing grants, repository uploads, backups, exports, and identity mappings will be checked against it immediately.");
    if (!confirmed) return;
    await onSave(record.configurationHash, policy);
  }

  function resetUnsavedChanges(): void {
    if (!record) return;
    setDraft(cloneOrganizationPolicy(record.policy));
    setRawText(JSON.stringify(record.policy, null, 2));
  }

  return <section className="administration-card organization-policy-card">
    <div className="administration-card-heading organization-policy-heading">
      <div><span><Settings2 size={18} /></span><div><h2>Organization policy</h2><p>Guided, secret-free controls for every enforced organization boundary.</p></div></div>
      <div className="organization-policy-actions">
        <a className="button button-secondary" href={organizationConfigurationUrl()} download="organization.formaspec.yaml"><Download size={14} /> Export YAML</a>
        <button className="button button-secondary" disabled={disabled || !dirty} onClick={resetUnsavedChanges}><RotateCcw size={14} /> Reset</button>
        <button className="button button-primary" disabled={disabled || !record} onClick={() => void savePolicy()}>
          {saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />} Save policy
        </button>
      </div>
    </div>

    {!record ? <div className="administration-empty"><LoaderCircle className="spin" size={20} /> {loading ? "Loading organization policy…" : "Organization policy is unavailable."}</div> : <div className="organization-policy-editor">
      <div className="organization-policy-meta">
        <span>Source: <strong>{record.source.replaceAll("_", " ")}</strong></span>
        <span>Schema: <strong>V{record.policy.schemaVersion}</strong></span>
        <span>Configuration lock: <code>{record.configurationHash}</code></span>
        <span>Policy SHA-256: <code>{record.policyHash}</code></span>
        <span>Updated {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(record.updatedAt))}</span>
        {dirty && <span className="is-dirty">Unsaved changes</span>}
      </div>
      <p className="organization-policy-lock-note"><ShieldCheck size={13} /> Saves use the displayed configuration lock. If another administrator changes policy first, the server rejects this save instead of overwriting their work.</p>
      {record.diagnostics.map((diagnostic) => (
        <div className={`administration-alert is-${diagnostic.severity}`} key={diagnostic.code}><ShieldCheck size={14} /><span>{diagnostic.message}</span></div>
      ))}

      <div className="organization-policy-mode-switch" aria-label="Organization policy editor mode">
        <button className={mode === "guided" ? "is-active" : ""} aria-pressed={mode === "guided"} onClick={() => selectMode("guided")}><CheckCircle2 size={13} /> Guided settings</button>
        <button className={mode === "json" ? "is-active" : ""} aria-pressed={mode === "json"} onClick={() => selectMode("json")}><Braces size={13} /> Expert JSON</button>
      </div>

      {mode === "guided" && draft && <>
        {validationIssues.length > 0 && <div className="organization-policy-validation" role="alert">
          <AlertTriangle size={16} />
          <div><strong>{validationIssues.length} policy issue{validationIssues.length === 1 ? "" : "s"}</strong><ul>{validationIssues.slice(0, 5).map((issue) => <li key={issue}>{issue}</li>)}</ul></div>
        </div>}

        <div className="organization-policy-guided">
          <PolicySection title="Localization" description="Locale coverage, default writing direction, and explicit RTL behavior.">
            <div className="organization-policy-fields">
              <label className="organization-policy-field">
                <span>Default locale</span>
                <input value={draft.localization.defaultLocale} disabled={disabled} onChange={(event) => replaceSection("localization", { ...draft.localization, defaultLocale: event.currentTarget.value })} />
                <small>BCP 47-style language tag, for example en-US or fa-IR.</small>
              </label>
              <PolicySelect
                label="Default direction"
                value={draft.localization.defaultDirection}
                options={["auto", "ltr", "rtl"]}
                disabled={disabled}
                onChange={(defaultDirection) => replaceSection("localization", { ...draft.localization, defaultDirection })}
              />
              <PolicyLineList
                label="Supported locales"
                description="One locale per line or comma-separated. The default locale must be present."
                value={draft.localization.supportedLocales}
                placeholder={"en-US\nfa-IR"}
                splitCommas
                disabled={disabled}
                onChange={(supportedLocales) => replaceSection("localization", { ...draft.localization, supportedLocales })}
              />
              <PolicyLineList
                label="RTL locales"
                description="Every RTL locale must also appear in supported locales."
                value={draft.localization.rtlLocales}
                placeholder="fa-IR"
                splitCommas
                disabled={disabled}
                onChange={(rtlLocales) => replaceSection("localization", { ...draft.localization, rtlLocales })}
              />
            </div>
          </PolicySection>

          <PolicySection title="Platforms" description="Allowed product targets and frame presets offered by the editor.">
            <PolicyChoiceSet
              label="Enabled product platforms"
              description="At least one platform is required."
              values={draft.platforms.enabled}
              options={ORGANIZATION_REPOSITORY_PLATFORMS}
              disabled={disabled}
              onChange={(enabled) => replaceSection("platforms", { ...draft.platforms, enabled })}
            />
            <PolicyChoiceSet
              label="Frame presets"
              description="Fixed-size variants available to product teams."
              values={draft.platforms.framePresets}
              options={ORGANIZATION_FRAME_PRESETS}
              disabled={disabled}
              onChange={(framePresets) => replaceSection("platforms", { ...draft.platforms, framePresets })}
            />
          </PolicySection>

          <PolicySection title="Design-system policy" description="Release discipline, reusable templates, fonts, and deterministic icons.">
            <div className="organization-policy-toggle-grid">
              <PolicyToggle
                label="Require a published release"
                description="Projects may only pin immutable published design-system releases."
                checked={draft.designSystem.requirePublishedRelease}
                disabled={disabled}
                onChange={(requirePublishedRelease) => replaceSection("designSystem", { ...draft.designSystem, requirePublishedRelease })}
              />
              <PolicyToggle
                label="Allow detached templates"
                description="Permit V1-style reusable patterns that insert independent node trees."
                checked={draft.designSystem.allowDetachedTemplates}
                disabled={disabled}
                onChange={(allowDetachedTemplates) => replaceSection("designSystem", { ...draft.designSystem, allowDetachedTemplates })}
              />
            </div>
            <PolicyLineList
              label="Approved font families"
              description="One deterministic or organization-approved family per line."
              value={draft.designSystem.approvedFontFamilies}
              placeholder={"Inter\nVazirmatn"}
              disabled={disabled}
              onChange={(approvedFontFamilies) => replaceSection("designSystem", { ...draft.designSystem, approvedFontFamilies })}
            />
            <PolicyLineList
              label="Approved icon sets"
              description="Only bundled, permissively licensed icon catalogs should be listed."
              value={draft.designSystem.approvedIconSets}
              placeholder="Lucide"
              disabled={disabled}
              onChange={(approvedIconSets) => replaceSection("designSystem", { ...draft.designSystem, approvedIconSets })}
            />
          </PolicySection>

          <PolicySection title="Assets" description="Upload allowlist, decoded-size limits, and fixed safe ingestion rules.">
            <PolicyToggle
              label="Enable asset uploads"
              description="When off, new portable and UI image uploads are rejected."
              checked={draft.assets.enabled}
              disabled={disabled}
              onChange={(enabled) => replaceSection("assets", { ...draft.assets, enabled })}
            />
            <PolicyChoiceSet
              label="Allowed normalized image types"
              description="Images are fully decoded, stripped, and deterministically re-encoded."
              values={draft.assets.allowedMimeTypes}
              options={ORGANIZATION_ASSET_MIME_TYPES}
              disabled={disabled}
              formatLabel={(value) => value}
              onChange={(allowedMimeTypes) => replaceSection("assets", { ...draft.assets, allowedMimeTypes })}
            />
            <div className="organization-policy-fields">
              <PolicyNumberField
                label="Maximum upload size"
                description="Server limit: 1 KiB through 64 MiB."
                value={Number((draft.assets.maximumBytes / 1_048_576).toFixed(3))}
                min={1 / 1_024}
                max={64}
                step={0.25}
                suffix="MiB"
                disabled={disabled}
                onChange={(maximumMiB) => replaceSection("assets", { ...draft.assets, maximumBytes: Math.round(maximumMiB * 1_048_576) })}
              />
              <PolicyNumberField
                label="Maximum decoded pixels"
                description="Rejects decompression bombs before canonical storage."
                value={draft.assets.maximumPixels}
                min={1}
                max={100_000_000}
                disabled={disabled}
                onChange={(maximumPixels) => replaceSection("assets", { ...draft.assets, maximumPixels })}
              />
            </div>
            <div className="organization-policy-fixed-grid">
              <FixedSecurityRule label="Animated images rejected" description="V1 policy is fixed to still images." />
              <FixedSecurityRule label="Remote URL fetching rejected" description="Assets must arrive through authenticated uploads." />
              <FixedSecurityRule label="SVG uploads rejected" description="Unsanitized vector markup never enters the renderer." />
            </div>
          </PolicySection>

          <PolicySection title="Naming" description="Canonical conventions for projects, components, and design tokens.">
            <div className="organization-policy-fields">
              <PolicySelect
                label="Project names"
                value={draft.naming.projectConvention}
                options={["sentence_case", "title_case", "kebab_case"]}
                disabled={disabled}
                onChange={(projectConvention) => replaceSection("naming", { ...draft.naming, projectConvention })}
              />
              <PolicySelect
                label="Component names"
                value={draft.naming.componentConvention}
                options={["pascal_case", "sentence_case", "kebab_case"]}
                disabled={disabled}
                onChange={(componentConvention) => replaceSection("naming", { ...draft.naming, componentConvention })}
              />
              <PolicySelect
                label="Token names"
                value={draft.naming.tokenConvention}
                options={["dot_case", "kebab_case"]}
                disabled={disabled}
                onChange={(tokenConvention) => replaceSection("naming", { ...draft.naming, tokenConvention })}
              />
            </div>
          </PolicySection>

          <PolicySection title="Accessibility" description="Lint and acceptance thresholds applied across every design.">
            <div className="organization-policy-fields">
              <PolicyNumberField
                label="Normal-text contrast"
                value={draft.accessibility.minimumContrastRatio}
                min={1}
                max={21}
                step={0.1}
                suffix=":1"
                disabled={disabled}
                onChange={(minimumContrastRatio) => replaceSection("accessibility", { ...draft.accessibility, minimumContrastRatio })}
              />
              <PolicyNumberField
                label="Large-text contrast"
                value={draft.accessibility.minimumLargeTextContrastRatio}
                min={1}
                max={21}
                step={0.1}
                suffix=":1"
                disabled={disabled}
                onChange={(minimumLargeTextContrastRatio) => replaceSection("accessibility", { ...draft.accessibility, minimumLargeTextContrastRatio })}
              />
              <PolicyNumberField
                label="Minimum touch target"
                value={draft.accessibility.minimumTouchTargetPx}
                min={24}
                max={96}
                suffix="CSS px"
                disabled={disabled}
                onChange={(minimumTouchTargetPx) => replaceSection("accessibility", { ...draft.accessibility, minimumTouchTargetPx })}
              />
            </div>
            <div className="organization-policy-toggle-grid">
              <PolicyToggle label="Require alternative text" description="Image/content lint requires meaningful text alternatives." checked={draft.accessibility.requireAlternativeText} disabled={disabled} onChange={(requireAlternativeText) => replaceSection("accessibility", { ...draft.accessibility, requireAlternativeText })} />
              <PolicyToggle label="Require focus state" description="Interactive component contracts must define keyboard focus." checked={draft.accessibility.requireFocusState} disabled={disabled} onChange={(requireFocusState) => replaceSection("accessibility", { ...draft.accessibility, requireFocusState })} />
              <PolicyToggle label="Require high-contrast context" description="Design systems must publish a high-contrast token context." checked={draft.accessibility.requireHighContrastContext} disabled={disabled} onChange={(requireHighContrastContext) => replaceSection("accessibility", { ...draft.accessibility, requireHighContrastContext })} />
            </div>
          </PolicySection>

          <PolicySection title="Agents and scopes" description="Adapter allowlist, grant lifetime, project boundaries, and every MCP capability." wide>
            <div className="organization-policy-toggle-grid columns-3">
              <PolicyToggle label="Enable agent connections" description="Allow scoped, expiring machine identities." checked={draft.agents.enabled} disabled={disabled} onChange={(enabled) => replaceSection("agents", { ...draft.agents, enabled })} />
              <PolicyToggle label="Allow legacy environment token" description="Compatibility only; managed Codex pairing does not export a bearer token." checked={draft.agents.allowLegacyEnvironmentToken} disabled={disabled} onChange={(allowLegacyEnvironmentToken) => replaceSection("agents", { ...draft.agents, allowLegacyEnvironmentToken })} />
              <PolicyToggle label="Require project restriction" description="Every agent grant must be limited to explicitly selected projects." checked={draft.agents.requireProjectRestriction} disabled={disabled} onChange={(requireProjectRestriction) => replaceSection("agents", { ...draft.agents, requireProjectRestriction })} />
            </div>
            <div className="organization-policy-fields columns-3">
              <PolicyNumberField label="Maximum grant lifetime" description="300 seconds through 30 days." value={draft.agents.maximumExpirySeconds} min={300} max={2_592_000} suffix="seconds" disabled={disabled} onChange={(maximumExpirySeconds) => replaceSection("agents", { ...draft.agents, maximumExpirySeconds })} />
              <PolicyNumberField label="Maximum active connections" value={draft.agents.maximumActiveConnections} min={1} max={100} disabled={disabled} onChange={(maximumActiveConnections) => replaceSection("agents", { ...draft.agents, maximumActiveConnections })} />
            </div>
            <PolicyChoiceSet
              label="Allowed adapters"
              description="Codex is managed automatically; generic MCP receives configuration instructions only."
              values={draft.agents.allowedAdapters}
              options={ORGANIZATION_AGENT_ADAPTERS}
              disabled={disabled}
              onChange={(allowedAdapters) => replaceSection("agents", { ...draft.agents, allowedAdapters })}
            />
            <div className="organization-policy-scope-intro"><ShieldCheck size={14} /><span><strong>Scope allowlist</strong><small>Allowlisting a scope does not grant it automatically. Human-only approval, implementation, cancellation, push, and pull-request decisions remain separately enforced.</small></span></div>
            <div className="organization-policy-scope-groups">
              {agentScopeGroups.map((group) => <fieldset key={group.title}>
                <legend>{group.title}</legend>
                {group.scopes.map((scope) => <label key={scope}>
                  <input
                    type="checkbox"
                    checked={draft.agents.allowedScopes.includes(scope)}
                    disabled={disabled}
                    onChange={(event) => replaceSection("agents", {
                      ...draft.agents,
                      allowedScopes: togglePolicyListValue<OrganizationAgentScope>(draft.agents.allowedScopes, scope, event.currentTarget.checked),
                    })}
                  />
                  <code>{scope}</code>
                </label>)}
              </fieldset>)}
            </div>
          </PolicySection>

          <PolicySection title="Repositories" description="Local Workspace Bridge inventory boundaries and mandatory safety defaults." wide>
            <div className="organization-policy-toggle-grid columns-3">
              <PolicyToggle label="Enable repository inventories" description="Allow explicitly granted local bridges to upload bounded inventories." checked={draft.repositories.enabled} disabled={disabled} onChange={(enabled) => replaceSection("repositories", { ...draft.repositories, enabled })} />
              <PolicyToggle label="Explicit grant required" description="Fixed on: each repository must be selected by a human." checked={draft.repositories.requireExplicitGrant} disabled onChange={() => undefined} />
              <PolicyToggle label="Read-only by default" description="Fixed on: inventory never implies source mutation permission." checked={draft.repositories.readOnlyByDefault} disabled onChange={() => undefined} />
            </div>
            <PolicyChoiceSet
              label="Allowed repository platforms"
              description="Scanners outside this allowlist are rejected."
              values={draft.repositories.allowedPlatforms}
              options={ORGANIZATION_REPOSITORY_PLATFORMS}
              disabled={disabled}
              onChange={(allowedPlatforms) => replaceSection("repositories", { ...draft.repositories, allowedPlatforms })}
            />
            <div className="organization-policy-fields">
              <PolicyNumberField
                label="Maximum inventory payload"
                description="1 KiB through 1 MiB after bounded normalization."
                value={Number((draft.repositories.maximumInventoryBytes / 1_024).toFixed(3))}
                min={1}
                max={1_024}
                step={1}
                suffix="KiB"
                disabled={disabled}
                onChange={(maximumKiB) => replaceSection("repositories", { ...draft.repositories, maximumInventoryBytes: Math.round(maximumKiB * 1_024) })}
              />
              <PolicyNumberField label="Maximum inventory entities" value={draft.repositories.maximumInventoryEntities} min={1} max={10_000} disabled={disabled} onChange={(maximumInventoryEntities) => replaceSection("repositories", { ...draft.repositories, maximumInventoryEntities })} />
              <PolicyLineList
                label="Secret exclusion patterns"
                description="One pattern per line. Repository-local paths and matching content never leave the workstation."
                value={draft.repositories.excludedPatterns}
                placeholder={".env\n*.pem\n**/secrets/**"}
                disabled={disabled}
                onChange={(excludedPatterns) => replaceSection("repositories", { ...draft.repositories, excludedPatterns })}
              />
            </div>
          </PolicySection>

          <PolicySection title="Backups and retention" description="Verified migration gates, UTC schedule, off-host policy, and 7/4/12-style retention.">
            <div className="organization-policy-toggle-grid">
              <PolicyToggle label="Enable managed backups" description="Allow verified online backup and restore operations." checked={draft.backups.enabled} disabled={disabled} onChange={(enabled) => replaceSection("backups", { ...draft.backups, enabled })} />
              <PolicyToggle label="Require off-host copy" description="Require an independently stored copy before backup policy is satisfied." checked={draft.backups.requireOffHostCopy} disabled={disabled} onChange={(requireOffHostCopy) => replaceSection("backups", { ...draft.backups, requireOffHostCopy })} />
              <PolicyToggle label="Verify before migration" description="Fixed on: V2 migration cannot proceed without a verified backup." checked={draft.backups.requireVerifiedBeforeMigration} disabled onChange={() => undefined} />
            </div>
            <div className="organization-policy-fields columns-4">
              <label className="organization-policy-field">
                <span>Daily backup time</span>
                <input type="time" value={backupScheduleToTime(draft.backups.scheduleUtc)} disabled={disabled} onChange={(event) => replaceSection("backups", { ...draft.backups, scheduleUtc: timeToBackupSchedule(event.currentTarget.value) })} />
                <small>UTC</small>
              </label>
              <PolicyNumberField label="Daily copies" value={draft.backups.retention.daily} min={1} max={3_650} disabled={disabled} onChange={(daily) => replaceSection("backups", { ...draft.backups, retention: { ...draft.backups.retention, daily } })} />
              <PolicyNumberField label="Weekly copies" value={draft.backups.retention.weekly} min={1} max={520} disabled={disabled} onChange={(weekly) => replaceSection("backups", { ...draft.backups, retention: { ...draft.backups.retention, weekly } })} />
              <PolicyNumberField label="Monthly copies" value={draft.backups.retention.monthly} min={1} max={120} disabled={disabled} onChange={(monthly) => replaceSection("backups", { ...draft.backups, retention: { ...draft.backups.retention, monthly } })} />
            </div>
          </PolicySection>

          <PolicySection title="Identity mappings" description="Map trusted reverse-proxy identity claims to organization roles." wide>
            <div className="organization-policy-identity-list">
              {draft.identity.roleMappings.length === 0 ? <div className="organization-policy-inline-empty"><ShieldCheck size={18} /><span><strong>No explicit identity mappings</strong><small>Local mode remains the local organization administrator. Server mode requires configured trusted mappings.</small></span></div> : draft.identity.roleMappings.map((mapping, index) => <div className="organization-policy-identity-row" key={index}>
                <PolicySelect
                  label={`Claim ${index + 1}`}
                  value={mapping.claim}
                  options={ORGANIZATION_IDENTITY_CLAIMS}
                  disabled={disabled}
                  onChange={(claim: OrganizationIdentityClaim) => updateRoleMapping(index, { claim })}
                />
                <label className="organization-policy-field">
                  <span>Exact claim value</span>
                  <input value={mapping.value} disabled={disabled} onChange={(event) => updateRoleMapping(index, { value: event.currentTarget.value })} />
                </label>
                <PolicySelect
                  label="Organization role"
                  value={mapping.role}
                  options={ORGANIZATION_HUMAN_ROLES}
                  disabled={disabled}
                  onChange={(role: OrganizationHumanRole) => updateRoleMapping(index, { role })}
                />
                <button className="icon-button is-danger" title="Remove identity mapping" aria-label={`Remove identity mapping ${index + 1}`} disabled={disabled} onClick={() => replaceSection("identity", { roleMappings: draft.identity.roleMappings.filter((_, mappingIndex) => mappingIndex !== index) })}><Trash2 size={14} /></button>
              </div>)}
            </div>
            <button className="button button-secondary organization-policy-add-mapping" disabled={disabled || draft.identity.roleMappings.length >= 100} onClick={() => replaceSection("identity", { roleMappings: [...draft.identity.roleMappings, { claim: "identity", value: "", role: "viewer" }] })}><Plus size={14} /> Add identity mapping</button>
          </PolicySection>

          <PolicySection title="Audit" description="Append-only event retention and optional read-event volume.">
            <div className="organization-policy-fields">
              <PolicyNumberField label="Audit retention" description="30 days through 10 years." value={draft.audit.retentionDays} min={30} max={3_650} suffix="days" disabled={disabled} onChange={(retentionDays) => replaceSection("audit", { ...draft.audit, retentionDays })} />
            </div>
            <PolicyToggle label="Include read events" description="Record bounded read operations as well as writes and security decisions." checked={draft.audit.includeReadEvents} disabled={disabled} onChange={(includeReadEvents) => replaceSection("audit", { ...draft.audit, includeReadEvents })} />
          </PolicySection>

          <PolicySection title="Exports" description="Portable project bundles, generated token targets, and preview defaults.">
            <div className="organization-policy-toggle-grid">
              <PolicyToggle label="Allow portable bundles" description="Permit bounded, checksummed .formaspec.zip import and export." checked={draft.exports.allowPortableBundles} disabled={disabled} onChange={(allowPortableBundles) => replaceSection("exports", { ...draft.exports, allowPortableBundles })} />
              <PolicyToggle label="Include previews by default" description="Portable exports include deterministic PNG previews unless explicitly omitted." checked={draft.exports.includePreviewsByDefault} disabled={disabled} onChange={(includePreviewsByDefault) => replaceSection("exports", { ...draft.exports, includePreviewsByDefault })} />
            </div>
            <PolicyChoiceSet
              label="Allowed token export formats"
              description="Generated outputs remain bounded and contain no credentials."
              values={draft.exports.allowedTokenFormats}
              options={ORGANIZATION_TOKEN_EXPORT_FORMATS}
              disabled={disabled}
              onChange={(allowedTokenFormats) => replaceSection("exports", { ...draft.exports, allowedTokenFormats })}
            />
          </PolicySection>
        </div>
      </>}

      {mode === "json" && <div className="organization-policy-expert">
        <div className="organization-policy-expert-warning"><Braces size={16} /><div><strong>Expert JSON</strong><small>The server applies the same strict schema, size limits, optimistic configuration lock, audit event, and immediate authorization checks. Unknown fields are rejected.</small></div></div>
        <textarea
          aria-label="Organization policy JSON"
          spellCheck={false}
          value={rawText}
          disabled={disabled}
          onChange={(event) => setRawText(event.currentTarget.value)}
        />
      </div>}

      <small className="organization-policy-secret-note">No passwords, bearer grants, Keychain values, repository paths, signing credentials, or provider secrets are accepted or exported by this policy schema.</small>
    </div>}
  </section>;
}
