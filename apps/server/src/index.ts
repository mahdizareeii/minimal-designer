import { buildApplication } from "./app.js";

const application = await buildApplication();

try {
  await application.app.listen({ host: application.config.host, port: application.config.port });
} catch (error) {
  application.app.log.error(error);
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void application.app.close().finally(() => process.exit(0));
  });
}
