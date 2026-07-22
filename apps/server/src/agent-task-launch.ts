const AGENT_TASK_ID = /^task_[a-f0-9]{32}$/;

export const FORMASPEC_CODEX_MENTION = "[@FormaSpec](plugin://formaspec@formaspec)";

export function agentTaskInstruction(taskId: string): string {
  if (!AGENT_TASK_ID.test(taskId)) throw new Error("Agent task ID is not safe for a Codex launch link.");
  return `${FORMASPEC_CODEX_MENTION}\n\nUse FormaSpec. Claim task ${taskId} with task_claim, call task_transition to move it to in_progress, and read its project context and selection. Call design_preview_changes with task_id ${taskId}, inspect its returned PNG in Codex, and call design_lint for that preview. Then call task_transition to awaiting_approval with data {"previewId":"<preview id>"}. Do not commit it; the website must show the exact PNG and human Commit button.`;
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

export function agentTaskWebsiteLink(publicBaseUrl: string, designId: string, taskId: string): string {
  const url = formaspecWebsiteUrl(publicBaseUrl, `/design/${encodeURIComponent(designId)}`);
  url.searchParams.set("task", taskId);
  return url.toString();
}

export function agentTaskPreviewReviewLink(
  publicBaseUrl: string,
  designId: string,
  previewId: string,
  taskId: string,
): string {
  const url = formaspecWebsiteUrl(
    publicBaseUrl,
    `/design/${encodeURIComponent(designId)}/previews/${encodeURIComponent(previewId)}/review`,
  );
  url.searchParams.set("task", taskId);
  return url.toString();
}
