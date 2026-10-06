import { Body, Controller, Delete, Get, Header, Inject, Param, Patch, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { AdminAuthGuard, AdminRequest } from "../auth/admin-auth.guard";
import { RequirePermissions } from "../auth/permissions.decorator";
import { PermissionsGuard } from "../auth/permissions.guard";
import { maximumTutorialVideoBytes, TutorialMediaService, TutorialUploadFile, tutorialUploadStorage } from "../tutorials/tutorial-media.service";
import { ViralRemakesService } from "./viral-remakes.service";
import { viralRemakeFilters } from "./viral-remakes.validation";

@Controller("viral-remakes")
export class ViralRemakesController {
  constructor(@Inject(ViralRemakesService) private readonly remakes: ViralRemakesService) {}

  @Get("categories")
  @Header("Cache-Control", "no-store")
  categories(@Query() query: Record<string, unknown>) { return this.remakes.categories(viralRemakeFilters(query), true); }

  @Get("templates")
  @Header("Cache-Control", "no-store")
  templates(@Query() query: Record<string, unknown>) { return this.remakes.templates(viralRemakeFilters(query), true); }

  @Get("templates/:templateId")
  @Header("Cache-Control", "no-store")
  template(@Param("templateId") id: string) { return this.remakes.templateGet(id, true); }
}

@Controller("admin/viral-remakes")
@UseGuards(AdminAuthGuard, PermissionsGuard)
@RequirePermissions("viral-remakes.manage")
export class ViralRemakesAdminController {
  constructor(
    @Inject(ViralRemakesService) private readonly remakes: ViralRemakesService,
    @Inject(TutorialMediaService) private readonly media: TutorialMediaService,
  ) {}

  @Get("categories")
  categories(@Query() query: Record<string, unknown>) { return this.remakes.categories(viralRemakeFilters(query, true), false); }

  @Get("categories/:categoryId")
  category(@Param("categoryId") id: string) { return this.remakes.categoryGet(id); }

  @Post("categories")
  categoryCreate(@Req() request: AdminRequest, @Body() value: unknown) { return this.remakes.categoryCreate(request.admin.sub, value); }

  @Patch("categories/:categoryId")
  categoryUpdate(@Req() request: AdminRequest, @Param("categoryId") id: string, @Body() value: unknown) { return this.remakes.categoryUpdate(request.admin.sub, id, value); }

  @Delete("categories/:categoryId")
  categoryDelete(@Req() request: AdminRequest, @Param("categoryId") id: string) { return this.remakes.categoryDelete(request.admin.sub, id); }

  @Get("templates")
  templates(@Query() query: Record<string, unknown>) { return this.remakes.templates(viralRemakeFilters(query, true), false); }

  @Get("templates/:templateId")
  template(@Param("templateId") id: string) { return this.remakes.templateGet(id); }

  @Post("templates")
  templateCreate(@Req() request: AdminRequest, @Body() value: unknown) { return this.remakes.templateCreate(request.admin.sub, value); }

  @Patch("templates/:templateId")
  templateUpdate(@Req() request: AdminRequest, @Param("templateId") id: string, @Body() value: unknown) { return this.remakes.templateUpdate(request.admin.sub, id, value); }

  @Delete("templates/:templateId")
  templateDelete(@Req() request: AdminRequest, @Param("templateId") id: string) { return this.remakes.templateDelete(request.admin.sub, id); }

  @Post("media")
  @UseInterceptors(FileInterceptor("file", { storage: tutorialUploadStorage, limits: { fileSize: maximumTutorialVideoBytes, files: 1, fields: 0 } }))
  upload(@Req() request: AdminRequest, @UploadedFile() file?: TutorialUploadFile) { return this.media.upload(request.admin.sub, file); }
}
