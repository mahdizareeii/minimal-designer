const AGENT_TASK_ID = /^task_[a-f0-9]{32}$/;
const DATA_STORE_ID = /^store_[a-f0-9]{32}$/;
const DESIGN_ID = /^document_[A-Za-z0-9][A-Za-z0-9_-]{7,199}$/;
const PREVIEW_ID = /^preview_[A-Za-z0-9][A-Za-z0-9_-]{7,199}$/;

export const FORMASPEC_CODEX_MENTION = "[@FormaSpec](plugin://formaspec@formaspec)";

export function agentTaskInstruction(taskId: string): string {
  if (!AGENT_TASK_ID.test(taskId)) throw new Error("Agent task ID is not safe for a Codex launch link.");
  return `${FORMASPEC_CODEX_MENTION}\n\nUse FormaSpec. Claim task ${taskId} with task_claim and move it to in_progress. Read its immutable Product, Design/base version, selection, organization policy, product specification, effective design-system release, tokens/components/states, comparable screens, and authorized repository inventories/mappings. Decide what is reused, extended, or proposed. Call design_preview_changes with task_id ${taskId}, inspect its returned PNG in Codex, and run design_lint. Refine until applicable senior UI/UX, product, accessibility, RTL/localization, responsive, prototype, and engineering checks are resolved or explicitly reported. Then call task_transition to awaiting_approval with data {"previewId":"<preview id>","readiness":<complete DesignReadinessReport matching the immutable task context and tool schema>}. Do not commit it; the website must show the exact PNG, readiness report, and human Commit button.`;
}

export function agentTaskCodexLaunchUrl(taskId: string): string {
  const url = new URL("codex://new");
  url.searchParams.set("prompt", agentTaskInstruction(taskId));
  if (url.protocol !== "codex:" || url.hostname !== "new" || url.username || url.password || url.port
    || url.pathname || url.hash || [...url.searchParams.keys()].some((key) => key !== "prompt")
    || url.searchParams.getAll("prompt").length !== 1) {
    throw new Error("Could not create a strict Codex task launch link.");
  }
  return url.toString();
}

function formaspecWebsiteUrl(publicBaseUrl: string, pathname: string): URL {
  const url = new URL(publicBaseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("FormaSpec website links require an HTTP(S) public base URL.");
  }
  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  url.pathname = `${basePath}${pathname}`;
  url.search = "";
  url.hash = "";
  url.username = "";
  url.password = "";
  return url;
}

export function agentTaskWebsiteLink(
  publicBaseUrl: string,
  designId: string,
  taskId: string,
  dataStoreId?: string,
): string {
  const url = formaspecWebsiteUrl(publicBaseUrl, `/design/${encodeURIComponent(designId)}`);
  url.searchParams.set("task", taskId);
  if (dataStoreId !== undefined) {
    if (!DATA_STORE_ID.test(dataStoreId)) throw new Error("FormaSpec data-store ID is invalid.");
    url.searchParams.set("store", dataStoreId);
  }
  return url.toString();
}

export function agentTaskPreviewReviewLink(
  publicBaseUrl: string,
  designId: string,
  previewId: string,
  taskId: string,
  dataStoreId?: string,
): string {
  const url = formaspecWebsiteUrl(
    publicBaseUrl,
    `/design/${encodeURIComponent(designId)}/previews/${encodeURIComponent(previewId)}/review`,
  );
  url.searchParams.set("task", taskId);
  if (dataStoreId !== undefined) {
    if (!DATA_STORE_ID.test(dataStoreId)) throw new Error("FormaSpec data-store ID is invalid.");
    url.searchParams.set("store", dataStoreId);
  }
  return url.toString();
}

export function agentTaskPreviewReviewLaunchLink(
  designId: string,
  previewId: string,
  taskId: string,
  dataStoreId: string,
): string {
  if (!DESIGN_ID.test(designId)
    || !PREVIEW_ID.test(previewId)
    || !AGENT_TASK_ID.test(taskId)
    || !DATA_STORE_ID.test(dataStoreId)) {
    throw new Error("FormaSpec review launcher identifiers are invalid.");
  }
  const url = new URL("formaspec://open-review");
  url.searchParams.set("design", designId);
  url.searchParams.set("preview", previewId);
  url.searchParams.set("task", taskId);
  url.searchParams.set("store", dataStoreId);
  if (url.protocol !== "formaspec:" || url.hostname !== "open-review" || url.pathname
    || url.username || url.password || url.port || url.hash
    || [...url.searchParams.keys()].join(",") !== "design,preview,task,store") {
    throw new Error("Could not create a strict FormaSpec review launch link.");
  }
  return url.toString();
}
