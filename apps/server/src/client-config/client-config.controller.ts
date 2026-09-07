import { Controller, Get, Header, Headers, Inject, Param, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { CatalogService } from "../catalog/catalog.service";
import { ClientConfigService } from "./client-config.service";
import { AuthMethodConfigService } from "../common/auth-method-config.service";
import { ProductBrandConfigService } from "../common/product-brand-config.service";
import { DesktopReleaseService } from "../common/desktop-release.service";

@Controller("client-config")
export class ClientConfigController {
  constructor(
    @Inject(ClientConfigService) private readonly configs: ClientConfigService,
    @Inject(CatalogService) private readonly catalogs: CatalogService,
    @Inject(AuthMethodConfigService) private readonly authMethodsConfig: AuthMethodConfigService,
    @Inject(ProductBrandConfigService) private readonly productBrandConfig: ProductBrandConfigService,
    @Inject(DesktopReleaseService) private readonly desktopReleases: DesktopReleaseService,
  ) {}

  @Get("bootstrap")
  bootstrap(): Record<string, unknown> {
    return {
      api_version: "v1",
      media_storage: "client_only",
      task_result_mode: "string_relay",
      config_merge_policy: "LOCAL_OVERRIDE_THEN_SERVER_DEFAULT_THEN_CLIENT_FALLBACK",
    };
  }

  @Get("auth-methods")
  @Header("Cache-Control", "no-store")
  authMethods() {
    return this.authMethodsConfig.publicConfig();
  }

  @Get("product-brand")
  @Header("Cache-Control", "no-store")
  productBrand() {
    return this.productBrandConfig.get();
  }

  @Get("releases/current")
  current(@Query("channel") channel?: string) {
    return this.configs.current(channel || "stable");
  }

  @Get("desktop-updates/:target/:arch/:currentVersion")
  @Header("Cache-Control", "no-store")
  async desktopUpdate(
    @Param("target") target: string,
    @Param("arch") arch: string,
    @Param("currentVersion") currentVersion: string,
    @Query("channel") channel: string | undefined,
    @Headers("x-update-cohort") cohort: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const update = await this.desktopReleases.selectUpdate({
      currentVersion,
      channel: channel || "stable",
      target,
      arch,
      cohort: typeof cohort === "string" ? cohort.slice(0, 128) : "",
    });
    if (!update) response.status(204);
    return update || undefined;
  }

  @Get("models")
  models() {
    return this.configs.models();
  }

  @Get("prompts")
  prompts(@Query("channel") channel?: string) {
    return this.configs.promptDefaults(channel || "stable");
  }

  @Get("visual-style-categories")
  visualStyleCategories() {
    return this.catalogs.publicCategories("visual-styles");
  }

  @Get("visual-styles")
  visualStyles() {
    return this.catalogs.publicItems("visual-styles");
  }

  @Get("creative-type-categories")
  creativeTypeCategories() {
    return this.catalogs.publicCategories("creative-types");
  }

  @Get("creative-types")
  creativeTypes() {
    return this.catalogs.publicItems("creative-types");
  }
}
