import { Controller, Get, Inject, Query } from "@nestjs/common";
import { CatalogService } from "../catalog/catalog.service";
import { ClientConfigService } from "./client-config.service";

@Controller("client-config")
export class ClientConfigController {
  constructor(
    @Inject(ClientConfigService) private readonly configs: ClientConfigService,
    @Inject(CatalogService) private readonly catalogs: CatalogService,
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

  @Get("releases/current")
  current(@Query("channel") channel?: string) {
    return this.configs.current(channel || "stable");
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
