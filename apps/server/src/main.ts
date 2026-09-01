import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { json, Request } from "express";
import { AppModule } from "./app.module";
import { setupApiDocs } from "./api-docs/setup-api-docs";
import { EnvironmentService } from "./config/environment.service";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const environment = app.get(EnvironmentService).values;
  // Trust only explicitly configured proxy IPs/CIDRs, never arbitrary forwarded headers.
  if (environment.trustProxy.length) app.getHttpAdapter().getInstance().set("trust proxy", environment.trustProxy);
  app.setGlobalPrefix("api/v1");
  setupApiDocs(app);
  app.enableCors({
    origin: [...new Set([...environment.adminOrigin.split(",").map((origin) => origin.trim()), ...environment.clientOrigins])],
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-ID", "Idempotency-Key"],
    credentials: false,
  });
  app.use(json({
    // Desktop media tasks may contain local reference images encoded as data URLs.
    limit: "120mb",
    strict: true,
    verify: (request, _response, buffer) => { (request as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer); },
  }));
  app.enableShutdownHooks();
  await app.listen(environment.port, environment.bindHost);
  process.stdout.write(`AI Video Studio server listening on port ${environment.port}\n`);
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`server startup failed: ${message}\n`);
  process.exitCode = 1;
});
