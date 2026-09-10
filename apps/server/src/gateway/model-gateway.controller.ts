import { Body, Controller, Get, Header, Inject, Param, Post, Req, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { asRecord, jsonValue, optionalString, requiredString } from "../common/input";
import { TemporaryReferenceImageService } from "../common/temporary-reference-image.service";
import { UserAuthGuard, UserRequest } from "../user-auth/user-auth.guard";
import { ModelGatewayService } from "./model-gateway.service";

@Controller("tasks")
@UseGuards(UserAuthGuard)
export class ModelGatewayController {
  constructor(@Inject(ModelGatewayService) private readonly gateway: ModelGatewayService,
    @Inject(TemporaryReferenceImageService) private readonly referenceImages: TemporaryReferenceImageService) {}

  @Post()
  create(@Req() request: UserRequest, @Body() input: unknown) {
    const body = asRecord(input);
    return this.gateway.create(request.user.sub, {
      localTaskId: optionalString(body, "local_task_id", 36),
      idempotencyKey: requiredString(body, "idempotency_key", 191),
      providerModelId: requiredString(body, "provider_model_id", 36),
      payload: jsonValue(body, "payload"),
      expectedCredits: body.expected_credits === undefined ? undefined : Number(body.expected_credits),
      workflowQuoteApprovalId: optionalString(body, "workflow_quote_approval_id", 36),
      workflowQuoteItemKey: optionalString(body, "workflow_quote_item_key", 191),
    });
  }

  @Post("quote")
  quote(@Body() input: unknown) {
    const body = asRecord(input);
    return this.gateway.quote({
      providerModelId: optionalString(body, "provider_model_id", 36),
      capability: optionalString(body, "capability", 40),
      payload: jsonValue(body, "payload"),
    });
  }

  @Post("workflow-quotes")
  approveWorkflowQuote(@Req() request: UserRequest, @Body() input: unknown) {
    const body = asRecord(input);
    const items = jsonValue(body, "items");
    return this.gateway.approveWorkflowQuote(request.user.sub, Array.isArray(items) ? items : []);
  }

  @Post("workflow-quotes/:approvalId/stop")
  stopWorkflowQuote(@Req() request: UserRequest, @Param("approvalId") approvalId: string) {
    return this.gateway.stopWorkflowQuote(request.user.sub, approvalId);
  }

  @Post("video-understanding/url")
  createVideoUnderstandingFromUrl(@Req() request: UserRequest, @Body() input: unknown) {
    const body = asRecord(input);
    return this.gateway.createVideoUnderstanding(request.user.sub, {
      idempotencyKey: requiredString(body, "idempotency_key", 191),
      prompt: requiredString(body, "prompt", 100_000),
      videoUrl: requiredString(body, "video_url", 8_192),
      mimeType: optionalString(body, "mime_type", 100),
      providerModelId: optionalString(body, "provider_model_id", 36),
      expectedCredits: body.expected_credits === undefined ? undefined : Number(body.expected_credits),
    });
  }

  @Post("reference-images")
  @UseInterceptors(FileInterceptor("image", { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  uploadReferenceImage(
    @Req() request: UserRequest,
    @UploadedFile() file?: { buffer: Buffer; mimetype: string; originalname: string; size: number },
  ) {
    const host = request.get("host") || "";
    return this.referenceImages.upload(request.user.sub, file, `${request.protocol}://${host}`);
  }

  @Post("video-understanding/upload")
  @UseInterceptors(FileInterceptor("video", { limits: { fileSize: 15 * 1024 * 1024, files: 1 } }))
  createVideoUnderstandingFromUpload(
    @Req() request: UserRequest,
    @Body() input: Record<string, unknown>,
    @UploadedFile() file?: { buffer: Buffer; mimetype: string; originalname: string; size: number },
  ) {
    const body = asRecord(input);
    return this.gateway.createVideoUnderstandingUpload(request.user.sub, {
      idempotencyKey: requiredString(body, "idempotency_key", 191),
      prompt: requiredString(body, "prompt", 100_000),
      file,
      providerModelId: optionalString(body, "provider_model_id", 36),
      expectedCredits: body.expected_credits === undefined ? undefined : Number(body.expected_credits),
    });
  }

  @Post("script-analysis/quote")
  scriptAnalysisQuote() {
    return this.gateway.scriptAnalysisQuote();
  }

  @Post("script-analysis/upload")
  @UseInterceptors(FileInterceptor("script", { limits: { fileSize: 20 * 1024 * 1024, files: 1 } }))
  createScriptAnalysisUpload(
    @Req() request: UserRequest,
    @Body() input: Record<string, unknown>,
    @UploadedFile() file?: { buffer: Buffer; mimetype: string; originalname: string; size: number },
  ) {
    const body = asRecord(input);
    return this.gateway.createScriptAnalysisUpload(request.user.sub, {
      idempotencyKey: requiredString(body, "idempotency_key", 191),
      expectedCredits: body.expected_credits === undefined ? undefined : Number(body.expected_credits),
      file,
    });
  }

  @Get()
  list(@Req() request: UserRequest) { return this.gateway.list(request.user.sub); }

  @Get(":taskId")
  get(@Req() request: UserRequest, @Param("taskId") taskId: string) { return this.gateway.get(request.user.sub, taskId); }

  @Get("by-local/:localId")
  getByLocal(@Req() request: UserRequest, @Param("localId") localId: string) { return this.gateway.getByLocal(request.user.sub, localId); }

  @Post(":taskId/query")
  query(@Req() request: UserRequest, @Param("taskId") taskId: string) { return this.gateway.query(request.user.sub, taskId); }
}

@Controller("temporary-reference-images")
export class TemporaryReferenceImageController {
  constructor(@Inject(TemporaryReferenceImageService) private readonly referenceImages: TemporaryReferenceImageService) {}

  @Get(":token")
  @Header("Cache-Control", "private, no-store, max-age=0")
  @Header("X-Content-Type-Options", "nosniff")
  async open(@Param("token") token: string, @Res({ passthrough: true }) response: Response) {
    const image = await this.referenceImages.open(token);
    response.type(image.mimeType);
    response.setHeader("Content-Length", String(image.size));
    response.setHeader("Content-Disposition", "inline");
    return new StreamableFile(image.stream);
  }
}
