import { Body, Controller, Delete, Get, Header, Inject, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { AdminAuthGuard, AdminRequest } from "../auth/admin-auth.guard";
import { RequirePermissions } from "../auth/permissions.decorator";
import { PermissionsGuard } from "../auth/permissions.guard";
import { asRecord, optionalString, requiredString } from "../common/input";
import { UserAuthGuard, UserRequest } from "../user-auth/user-auth.guard";
import { ScriptLibraryService } from "./script-library.service";

@Controller("script-library")
export class ScriptLibraryController {
  constructor(@Inject(ScriptLibraryService) private readonly library: ScriptLibraryService) {}
  @Get("categories") categories() { return this.library.publicCategories(); }
  @Get("scripts") scripts(@Query("q") query?: string, @Query("category") category?: string) { return this.library.publicScripts(query, category); }
  @Get("scripts/:scriptId") script(@Param("scriptId") scriptId: string) { return this.library.publicScript(scriptId); }
  @Get("quote") @UseGuards(UserAuthGuard) @Header("Cache-Control", "no-store") quote() { return this.library.quote(); }
  @Post("scripts/:scriptId/create-project") @UseGuards(UserAuthGuard)
  createProject(@Req() request: UserRequest, @Param("scriptId") scriptId: string, @Body() input: unknown) {
    const body = asRecord(input);
    return this.library.useScript(request.user.sub, scriptId, requiredString(body, "idempotency_key", 191), Number(body.expected_credits));
  }
}

@Controller("admin/script-library")
@UseGuards(AdminAuthGuard, PermissionsGuard)
@RequirePermissions("scripts.manage")
export class ScriptLibraryAdminController {
  constructor(@Inject(ScriptLibraryService) private readonly library: ScriptLibraryService) {}
  @Get("config") config() { return this.library.config(); }
  @Patch("config") updateConfig(@Req() request: AdminRequest, @Body() input: unknown) {
    const body = asRecord(input); return this.library.updateConfig(request.admin.sub, Number(body.credit_cost), Number(body.revision));
  }
  @Get("categories") categories() { return this.library.adminCategories(); }
  @Post("categories") createCategory(@Req() request: AdminRequest, @Body() input: unknown) { return this.library.createCategory(request.admin.sub, this.categoryInput(asRecord(input))); }
  @Patch("categories/:categoryId") updateCategory(@Req() request: AdminRequest, @Param("categoryId") id: string, @Body() input: unknown) { return this.library.updateCategory(request.admin.sub, id, this.categoryInput(asRecord(input))); }
  @Delete("categories/:categoryId") deleteCategory(@Req() request: AdminRequest, @Param("categoryId") id: string) { return this.library.deleteCategory(request.admin.sub, id); }
  @Get("scripts") scripts() { return this.library.adminScripts(); }
  @Post("scripts") createScript(@Req() request: AdminRequest, @Body() input: unknown) { return this.library.createScript(request.admin.sub, this.scriptInput(asRecord(input))); }
  @Patch("scripts/:scriptId") updateScript(@Req() request: AdminRequest, @Param("scriptId") id: string, @Body() input: unknown) { return this.library.updateScript(request.admin.sub, id, this.scriptInput(asRecord(input))); }
  @Delete("scripts/:scriptId") deleteScript(@Req() request: AdminRequest, @Param("scriptId") id: string) { return this.library.deleteScript(request.admin.sub, id); }

  private categoryInput(body: Record<string, unknown>) {
    return { code: requiredString(body, "code", 64), name: requiredString(body, "name", 100), description: optionalString(body, "description", 500), sortOrder: Number(body.sort_order), status: optionalString(body, "status", 32) || "ACTIVE" };
  }
  private scriptInput(body: Record<string, unknown>) {
    return { categoryId: requiredString(body, "category_id", 36), title: requiredString(body, "title", 200), durationSeconds: Number(body.duration_seconds), summary: optionalString(body, "summary", 1000), content: requiredString(body, "content", 2_000_000), canonical: body.canonical, sortOrder: Number(body.sort_order), status: optionalString(body, "status", 32) || "ACTIVE" };
  }
}
