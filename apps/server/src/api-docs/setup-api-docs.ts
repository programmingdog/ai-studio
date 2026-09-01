import { INestApplication } from "@nestjs/common";
import { SwaggerModule } from "@nestjs/swagger";
import { createApiDocument } from "./api-document";

export function setupApiDocs(app: INestApplication): void {
  SwaggerModule.setup("api-docs", app, createApiDocument(), {
    customSiteTitle: "AI Video Studio · API 文档",
    customfavIcon: "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 64 64%22><rect width=%2264%22 height=%2264%22 rx=%2214%22 fill=%22%23131827%22/><path d=%22M18 44 31 16l15 28h-9l-3-7H24l-3 7z%22 fill=%22%237c8cff%22/></svg>",
    customCss: `
      .swagger-ui .topbar { background: #101522; border-bottom: 1px solid #27304a; }
      .swagger-ui .topbar .download-url-wrapper { display: none; }
      .swagger-ui .info .title { color: #172033; }
      .swagger-ui .opblock-tag { color: #172033; }
      .swagger-ui .btn.authorize { color: #5668d8; border-color: #5668d8; }
      .swagger-ui .btn.authorize svg { fill: #5668d8; }
    `,
    jsonDocumentUrl: "/api-docs/openapi.json",
    yamlDocumentUrl: "/api-docs/openapi.yaml",
    swaggerOptions: {
      deepLinking: true,
      displayRequestDuration: true,
      docExpansion: "none",
      filter: true,
      persistAuthorization: true,
      tagsSorter: "alpha",
      operationsSorter: "method",
    },
  });
}
