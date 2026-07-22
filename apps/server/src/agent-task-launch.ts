const AGENT_TASK_ID = /^task_[a-f0-9]{32}$/;

export const FORMASPEC_CODEX_MENTION = "[@FormaSpec](plugin://formaspec@formaspec)";

export function agentTaskInstruction(taskId: string): string {
  if (!AGENT_TASK_ID.test(taskId)) throw new Error("Agent task ID is not safe for a Codex launch link.");
  return `${FORMASPEC_CODEX_MENTION}\n\nUse FormaSpec. Claim task ${taskId} with task_claim, call task_transition to move it to in_progress, read its project context and selection, create and inspect a rendered design preview, and run linting. Then call task_transition to awaiting_approval with data {"previewId":"<preview id>"}. Do not commit it; the website must show the exact PNG and human Commit button.`;
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
