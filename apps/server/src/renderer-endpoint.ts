import path from "node:path";

export const DEFAULT_UNIX_RENDERER_SOCKET = "/run/formaspec/renderer.sock";
export const DEFAULT_WINDOWS_RENDERER_PIPE = "\\\\.\\pipe\\formaspec-renderer";

const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";
const MAX_UNIX_SOCKET_PATH_LENGTH = 100;
const MAX_WINDOWS_PIPE_PATH_LENGTH = 256;

export type RendererEndpointKind = "unix-socket" | "windows-named-pipe";

export function rendererEndpointKind(endpoint: string): RendererEndpointKind {
  return endpoint.toLowerCase().startsWith(WINDOWS_PIPE_PREFIX.toLowerCase())
    ? "windows-named-pipe"
    : "unix-socket";
}

export function defaultRendererEndpoint(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? DEFAULT_WINDOWS_RENDERER_PIPE : DEFAULT_UNIX_RENDERER_SOCKET;
}

export function validateRendererEndpoint(
  endpoint: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    if (rendererEndpointKind(endpoint) !== "windows-named-pipe"
      || endpoint.length > MAX_WINDOWS_PIPE_PATH_LENGTH
      || endpoint.includes("/")
      || /[\u0000-\u001f\u007f]/.test(endpoint)) {
      throw new Error(
        "FORMASPEC_RENDER_SOCKET must be a Windows named pipe such as \\\\.\\pipe\\formaspec-renderer (maximum 256 characters)",
      );
    }
    const name = endpoint.slice(WINDOWS_PIPE_PREFIX.length);
    const segments = name.split("\\");
    if (!name || segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error("FORMASPEC_RENDER_SOCKET contains an invalid Windows named-pipe name.");
    }
    return endpoint;
  }

  if (rendererEndpointKind(endpoint) !== "unix-socket"
    || !path.posix.isAbsolute(endpoint)
    || endpoint.length > MAX_UNIX_SOCKET_PATH_LENGTH
    || /[\u0000-\u001f\u007f]/.test(endpoint)) {
    throw new Error(
      "FORMASPEC_RENDER_SOCKET must be an absolute Unix-domain-socket path of at most 100 characters",
    );
  }
  return endpoint;
}
