import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";
import {
  containerHealthcheckRequestOptions,
  resolveContainerHealthcheckTarget,
} from "./container-healthcheck.js";

describe("container healthcheck", () => {
  it("uses an allowed loopback Host in local container mode", () => {
    const target = resolveContainerHealthcheckTarget({
      APP_MODE: "local",
      PORT: "4310",
      PUBLIC_BASE_URL: "http://localhost:4310",
      FORMASPEC_ALLOWED_HOSTS: "localhost:4310,127.0.0.1:4310",
    });
    expect(target).toEqual({
      connectHost: "127.0.0.1",
      port: 4310,
      hostHeader: "localhost:4310",
      path: "/health/ready",
    });
  });

  it("derives the strict server-mode Host from PUBLIC_BASE_URL while connecting internally", () => {
    const environment = {
      APP_MODE: "server",
      HOST: "0.0.0.0",
      PORT: "4310",
      DATA_DIR: "/tmp/formaspec-healthcheck-test",
      PUBLIC_BASE_URL: "https://designer.company.example:8443",
      AUTH_MODE: "trusted-header",
      DESIGNER_TOKEN: "healthcheck-server-token-0001",
      FORMASPEC_PROXY_SECRET: "proxy-secret-0123456789abcdef0123456789abcdef",
      FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
      FORMASPEC_CONTAINER_LOCAL: "false",
    };
    const target = resolveContainerHealthcheckTarget(environment);
    const config = loadConfig(environment);
    expect(target).toEqual({
      connectHost: "127.0.0.1",
      port: 4310,
      hostHeader: "designer.company.example:8443",
      path: "/health/ready",
    });
    expect(config.allowedHosts).toContain(target.hostHeader);
  });

  it("builds a credential-free readiness request", () => {
    const request = containerHealthcheckRequestOptions(resolveContainerHealthcheckTarget({
      APP_MODE: "server",
      PORT: "4310",
      PUBLIC_BASE_URL: "https://designer.company.example",
    }));
    expect(request).toMatchObject({
      hostname: "127.0.0.1",
      port: 4310,
      path: "/health/ready",
      method: "GET",
      headers: {
        accept: "application/json",
        host: "designer.company.example",
      },
    });
    expect(request.headers).not.toHaveProperty("authorization");
    expect(request.headers).not.toHaveProperty("cookie");
    expect(request.headers).not.toHaveProperty("x-formaspec-proxy-secret");
  });

  it("fails closed for invalid server-mode healthcheck configuration", () => {
    expect(() => resolveContainerHealthcheckTarget({ APP_MODE: "server", PORT: "4310" }))
      .toThrow(/PUBLIC_BASE_URL/);
    expect(() => resolveContainerHealthcheckTarget({
      APP_MODE: "server",
      PORT: "4310",
      PUBLIC_BASE_URL: "http://designer.company.example",
    })).toThrow(/HTTPS/);
  });
});
