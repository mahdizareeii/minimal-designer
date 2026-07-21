import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthenticationForm, parseBootstrapTokenFragment } from "../components/SessionAuthentication";
import {
  bootstrapBrowserAdministrator,
  loginBrowserAdministrator,
  logoutBrowserAdministrator,
  readBrowserAuthentication,
} from "../lib/api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FormaSpec browser administrator authentication", () => {
  it("renders distinct first-run bootstrap and returning-login forms", () => {
    const bootstrap = renderToStaticMarkup(
      <AuthenticationForm bootstrapRequired busy={false} error={null} onSubmit={() => {}} onRetry={() => {}} />,
    );
    expect(bootstrap).toContain("Create the first administrator");
    expect(bootstrap).toContain("Display name");
    expect(bootstrap).toContain("Create administrator");
    expect(bootstrap).toContain('minLength="12"');

    const protectedBootstrap = renderToStaticMarkup(
      <AuthenticationForm bootstrapRequired bootstrapTokenRequired busy={false} error={null} onSubmit={() => {}} onRetry={() => {}} />,
    );
    expect(protectedBootstrap).toContain("One-time setup code");
    expect(protectedBootstrap).toContain("./designer server init");

    const login = renderToStaticMarkup(
      <AuthenticationForm bootstrapRequired={false} busy={false} error="Invalid login credentials." onSubmit={() => {}} onRetry={() => {}} />,
    );
    expect(login).toContain("Sign in to FormaSpec");
    expect(login).not.toContain("Display name");
    expect(login).toContain("Invalid login credentials.");
  });

  it("accepts only one strict fragment-carried bootstrap token", () => {
    const token = "setup_0123456789abcdefghijklmnopqrstuvwxyzABCDE";
    expect(parseBootstrapTokenFragment(`#bootstrap=${token}`)).toBe(token);
    expect(parseBootstrapTokenFragment(`#bootstrap=${token}&unexpected=1`)).toBeNull();
    expect(parseBootstrapTokenFragment("#bootstrap=short")).toBeNull();
    expect(parseBootstrapTokenFragment(`#bootstrap=${token}&bootstrap=${token}`)).toBeNull();
  });

  it("uses fixed bootstrap/login intent then rotates protected writes to the session CSRF token", async () => {
    const csrfToken = "csrf_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const authenticated = {
      mode: "session" as const,
      bootstrapRequired: false,
      authenticated: true,
      csrfToken,
      account: {
        principalId: "principal_admin0001",
        organizationId: "organization_legacy",
        loginName: "admin@example.test",
        displayName: "FormaSpec Administrator",
        role: "organization_admin",
      },
    };
    const responses = [
      jsonResponse({ mode: "session", bootstrapRequired: true, authenticated: false }),
      jsonResponse(authenticated, 201),
      new Response(null, { status: 204 }),
      jsonResponse(authenticated),
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected request");
      return response;
    }));

    await readBrowserAuthentication();
    await bootstrapBrowserAdministrator({
      loginName: "admin@example.test",
      displayName: "FormaSpec Administrator",
      password: "correct horse battery staple 2026",
    });
    await logoutBrowserAdministrator();
    await loginBrowserAdministrator({
      loginName: "admin@example.test",
      password: "correct horse battery staple 2026",
    });

    expect(calls.map((call) => call.url)).toEqual([
      "/api/auth/status",
      "/api/auth/bootstrap",
      "/api/auth/logout",
      "/api/auth/login",
    ]);
    expect(calls.every((call) => call.init.credentials === "same-origin")).toBe(true);
    expect(new Headers(calls[1]!.init.headers).get("x-formaspec-csrf")).toBe("1");
    expect(new Headers(calls[2]!.init.headers).get("x-formaspec-csrf")).toBe(csrfToken);
    expect(new Headers(calls[3]!.init.headers).get("x-formaspec-csrf")).toBe("1");
  });
});
