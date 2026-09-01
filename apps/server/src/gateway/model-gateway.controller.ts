import { Body, Controller, Get, Inject, Param, Post, Req, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { asRecord, jsonValue, optionalString, requiredString } from "../common/input";
import { UserAuthGuard, UserRequest } from "../user-auth/user-auth.guard";
import { ModelGatewayService } from "./model-gateway.service";

@Controller("tasks")
@UseGuards(UserAuthGuard)
export class ModelGatewayController {
  constructor(@Inject(ModelGatewayService) private readonly gateway: ModelGatewayService) {}

  @Post()
  create(@Req() request: UserRequest, @Body() input: unknown) {
    const body = asRecord(input);
    return this.gateway.create(request.user.sub, {
      localTaskId: optionalString(body, "local_task_id", 36),
      idempotencyKey: requiredString(body, "idempotency_key", 191),
      providerModelId: requiredString(body, "provider_model_id", 36),
      payload: jsonValue(body, "payload"),
      expectedCredits: body.expected_credits === undefined ? undefined : Number(body.expected_credits),
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

  @Get()
  list(@Req() request: UserRequest) { return this.gateway.list(request.user.sub); }

  @Get(":taskId")
  get(@Req() request: UserRequest, @Param("taskId") taskId: string) { return this.gateway.get(request.user.sub, taskId); }

  @Get("by-local/:localId")
  getByLocal(@Req() request: UserRequest, @Param("localId") localId: string) { return this.gateway.getByLocal(request.user.sub, localId); }

  @Post(":taskId/query")
  query(@Req() request: UserRequest, @Param("taskId") taskId: string) { return this.gateway.query(request.user.sub, taskId); }
}
