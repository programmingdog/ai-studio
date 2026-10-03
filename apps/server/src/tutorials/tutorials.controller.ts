import { Body, Controller, Delete, Get, Header, Headers, Inject, Param, Patch, Post, Query, Req, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { AdminAuthGuard, AdminRequest } from "../auth/admin-auth.guard";
import { RequirePermissions } from "../auth/permissions.decorator";
import { PermissionsGuard } from "../auth/permissions.guard";
import { maximumTutorialVideoBytes, parseTutorialRange, TutorialMediaService, TutorialUploadFile, tutorialUploadStorage } from "./tutorial-media.service";
import { TutorialsService } from "./tutorials.service";
import { tutorialPage } from "./tutorials.validation";

@Controller("tutorials")
export class TutorialsController {
  constructor(
    @Inject(TutorialsService) private readonly tutorials: TutorialsService,
    @Inject(TutorialMediaService) private readonly media: TutorialMediaService,
  ) {}

  @Get()
  @Header("Cache-Control", "no-store")
  list(@Query("page") page?: string) { return this.tutorials.publicList(tutorialPage(page)); }

  @Get("media/:assetId")
  async download(@Param("assetId") id: string, @Headers("range") range: string | undefined, @Res({ passthrough: true }) response: Response) {
    const file = await this.media.open(id);
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Content-Type", file.mimeType);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    const part = parseTutorialRange(range, file.size);
    if (part === "UNSATISFIABLE") {
      await file.handle.close();
      response.status(416);
      response.setHeader("Content-Range", `bytes */${file.size}`);
      response.setHeader("Content-Length", "0");
      return;
    }
    if (part) {
      response.status(206);
      response.setHeader("Content-Range", `bytes ${part.start}-${part.end}/${file.size}`);
      response.setHeader("Content-Length", String(part.end - part.start + 1));
      return new StreamableFile(file.handle.createReadStream({ start: part.start, end: part.end }));
    }
    response.setHeader("Content-Length", String(file.size));
    return new StreamableFile(file.handle.createReadStream());
  }

  @Get(":tutorialId")
  @Header("Cache-Control", "no-store")
  get(@Param("tutorialId") id: string) { return this.tutorials.publicGet(id); }
}

@Controller("admin/tutorials")
@UseGuards(AdminAuthGuard, PermissionsGuard)
@RequirePermissions("tutorials.manage")
export class TutorialsAdminController {
  constructor(
    @Inject(TutorialsService) private readonly tutorials: TutorialsService,
    @Inject(TutorialMediaService) private readonly media: TutorialMediaService,
  ) {}

  @Get()
  list(@Query("page") page?: string, @Query("query") query?: string) { return this.tutorials.adminList(tutorialPage(page), query); }

  @Post("media")
  @UseInterceptors(FileInterceptor("file", { storage: tutorialUploadStorage, limits: { fileSize: maximumTutorialVideoBytes, files: 1, fields: 0 } }))
  upload(@Req() request: AdminRequest, @UploadedFile() file?: TutorialUploadFile) { return this.media.upload(request.admin.sub, file); }

  @Get(":tutorialId")
  get(@Param("tutorialId") id: string) { return this.tutorials.adminGet(id); }

  @Post()
  create(@Req() request: AdminRequest, @Body() value: unknown) { return this.tutorials.create(request.admin.sub, value); }

  @Patch(":tutorialId")
  update(@Req() request: AdminRequest, @Param("tutorialId") id: string, @Body() value: unknown) { return this.tutorials.update(request.admin.sub, id, value); }

  @Delete(":tutorialId")
  delete(@Req() request: AdminRequest, @Param("tutorialId") id: string) { return this.tutorials.delete(request.admin.sub, id); }
}
