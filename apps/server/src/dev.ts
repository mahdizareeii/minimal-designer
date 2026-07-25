const webHost = process.env.DESIGNER_WEB_HOST?.trim() || "127.0.0.1";
const webPort = process.env.DESIGNER_WEB_PORT?.trim() || "4311";
process.env.FORMASPEC_WEB_BASE_URL ??= `http://${webHost}:${webPort}`;

await import("./index.js");

export {};
