import { BadRequestException, Body, Controller, Delete, Get, Header, Inject, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { AdminAuthGuard, AdminRequest } from "../auth/admin-auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import { RequirePermissions } from "../auth/permissions.decorator";
import { CatalogService, type CatalogKind } from "../catalog/catalog.service";
import { asRecord, jsonValue, optionalString, requiredString } from "../common/input";
import { AdminService } from "./admin.service";
import { CreditAdminService } from "./credit-admin.service";
import { ModelTestService } from "./model-test.service";
import { WechatPaymentConfigService } from "./wechat-payment-config.service";
import { ProviderPricingService } from "./provider-pricing.service";
import { CreditPricingService } from "./credit-pricing.service";
import { ModelCreditMultiplierService } from "../common/model-credit-multiplier.service";
import { MailConfigService } from "../mail/mail-config.service";

@Controller("admin")
@UseGuards(AdminAuthGuard, PermissionsGuard)
export class AdminController {
  constructor(
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(CreditAdminService) private readonly credits: CreditAdminService,
    @Inject(ModelTestService) private readonly modelTests: ModelTestService,
    @Inject(WechatPaymentConfigService) private readonly wechatPaymentConfig: WechatPaymentConfigService,
    @Inject(CatalogService) private readonly catalogs: CatalogService,
    @Inject(ProviderPricingService) private readonly providerPricing: ProviderPricingService,
    @Inject(CreditPricingService) private readonly creditPricing: CreditPricingService,
    @Inject(ModelCreditMultiplierService) private readonly creditMultipliers: ModelCreditMultiplierService,
    @Inject(MailConfigService) private readonly mailConfig: MailConfigService,
  ) {}

  @Get("catalogs/:kind/categories")
  @RequirePermissions("configs.manage")
  listCatalogCategories(@Param("kind") kind: CatalogKind) {
    return this.catalogs.adminCategories(kind);
  }

  @Post("catalogs/:kind/categories")
  @RequirePermissions("configs.manage")
  createCatalogCategory(@Req() request: AdminRequest, @Param("kind") kind: CatalogKind, @Body() input: unknown) {
    return this.catalogs.createCategory(request.admin.sub, kind, this.catalogCategoryInput(asRecord(input)));
  }

  @Patch("catalogs/:kind/categories/:categoryId")
  @RequirePermissions("configs.manage")
  updateCatalogCategory(@Req() request: AdminRequest, @Param("kind") kind: CatalogKind, @Param("categoryId") categoryId: string, @Body() input: unknown) {
    return this.catalogs.updateCategory(request.admin.sub, kind, categoryId, this.catalogCategoryInput(asRecord(input)));
  }

  @Delete("catalogs/:kind/categories/:categoryId")
  @RequirePermissions("configs.manage")
  deleteCatalogCategory(@Req() request: AdminRequest, @Param("kind") kind: CatalogKind, @Param("categoryId") categoryId: string) {
    return this.catalogs.deleteCategory(request.admin.sub, kind, categoryId);
  }

  @Get("catalogs/:kind/items")
  @RequirePermissions("configs.manage")
  listCatalogItems(@Param("kind") kind: CatalogKind) {
    return this.catalogs.adminItems(kind);
  }

  @Post("catalogs/:kind/items")
  @RequirePermissions("configs.manage")
  createCatalogItem(@Req() request: AdminRequest, @Param("kind") kind: CatalogKind, @Body() input: unknown) {
    const body = asRecord(input);
    return this.catalogs.createItem(request.admin.sub, kind, { ...this.catalogCategoryInput(body), categoryId: requiredString(body, "category_id", 36), prompt: requiredString(body, "prompt", 10000) });
  }

  @Patch("catalogs/:kind/items/:itemId")
  @RequirePermissions("configs.manage")
  updateCatalogItem(@Req() request: AdminRequest, @Param("kind") kind: CatalogKind, @Param("itemId") itemId: string, @Body() input: unknown) {
    const body = asRecord(input);
    return this.catalogs.updateItem(request.admin.sub, kind, itemId, { ...this.catalogCategoryInput(body), categoryId: requiredString(body, "category_id", 36), prompt: requiredString(body, "prompt", 10000) });
  }

  @Delete("catalogs/:kind/items/:itemId")
  @RequirePermissions("configs.manage")
  deleteCatalogItem(@Req() request: AdminRequest, @Param("kind") kind: CatalogKind, @Param("itemId") itemId: string) {
    return this.catalogs.deleteItem(request.admin.sub, kind, itemId);
  }

  @Get("dashboard/overview")
  @RequirePermissions("dashboard.read")
  overview(): Promise<Record<string, number>> {
    return this.admin.overview();
  }

  @Get("configs")
  @RequirePermissions("configs.manage")
  listConfigs(@Query("category") category?: string): Promise<Record<string, unknown>[]> {
    return this.admin.listConfigs(category);
  }

  @Post("configs")
  @RequirePermissions("configs.manage")
  createConfig(@Req() request: AdminRequest, @Body() input: unknown) {
    const body = asRecord(input);
    return this.admin.createConfig(request.admin.sub, {
      configKey: requiredString(body, "config_key", 191),
      category: requiredString(body, "category", 32),
      name: requiredString(body, "name", 150),
      description: optionalString(body, "description", 1000),
      value: jsonValue(body, "value"),
      changeNote: optionalString(body, "change_note", 500),
    });
  }

  @Post("configs/:configSetId/versions")
  @RequirePermissions("configs.manage")
  createConfigVersion(@Req() request: AdminRequest, @Param("configSetId") configSetId: string, @Body() input: unknown) {
    const body = asRecord(input);
    return this.admin.createConfigVersion(request.admin.sub, configSetId, {
      value: jsonValue(body, "value"),
      changeNote: optionalString(body, "change_note", 500),
    });
  }

  @Post("configs/:configSetId/versions/:versionId/publish")
  @RequirePermissions("configs.manage")
  publishConfig(
    @Req() request: AdminRequest,
    @Param("configSetId") configSetId: string,
    @Param("versionId") versionId: string,
    @Body() input: unknown,
  ) {
    const body = asRecord(input || {});
    const rollout = body.rollout_percent === undefined ? undefined : Number(body.rollout_percent);
    return this.admin.publishConfig(request.admin.sub, configSetId, versionId, {
      channel: optionalString(body, "channel", 32),
      minClientVersion: optionalString(body, "min_client_version", 32),
      rolloutPercent: rollout,
    });
  }

  @Get("configs/wechat-payment")
  @RequirePermissions("payments.manage")
  getWechatPaymentConfig() {
    return this.wechatPaymentConfig.get();
  }

  @Patch("configs/wechat-payment")
  @RequirePermissions("payments.manage")
  updateWechatPaymentConfig(@Req() request: AdminRequest, @Body() input: unknown) {
    const body = asRecord(input);
    return this.wechatPaymentConfig.update(request.admin.sub, {
      merchantId: requiredString(body, "merchant_id", 32),
      paymentNotifyUrl: requiredString(body, "payment_notify_url", 500),
      merchantKey: optionalString(body, "merchant_key", 128),
      certificateContent: optionalString(body, "certificate_content", 600000),
      certificateFilename: optionalString(body, "certificate_filename", 255),
      privateKeyContent: optionalString(body, "private_key_content", 600000),
      privateKeyFilename: optionalString(body, "private_key_filename", 255),
      platformCertificateContent: optionalString(body, "platform_certificate_content", 600000),
      platformCertificateFilename: optionalString(body, "platform_certificate_filename", 255),
      officialAccountName: requiredString(body, "official_account_name", 100),
      appId: requiredString(body, "app_id", 64),
      appSecret: optionalString(body, "app_secret", 128),
      openPlatformAppId: requiredString(body, "open_platform_app_id", 64),
      openPlatformAppSecret: optionalString(body, "open_platform_app_secret", 128),
      openPlatformRedirectUri: requiredString(body, "open_platform_redirect_uri", 500),
      status: optionalString(body, "status", 32) || "DISABLED",
    });
  }

  @Get("providers")
  @RequirePermissions("providers.manage")
  listProviders() {
    return this.admin.listProviders();
  }

  @Get("configs/credit-pricing")
  @RequirePermissions("configs.manage")
  getCreditPricingConfig() { return this.creditPricing.get(); }

  @Get("configs/mail")
  @Header("Cache-Control", "no-store")
  @RequirePermissions("configs.manage")
  getMailConfig() { return this.mailConfig.get(); }

  @Patch("configs/mail")
  @Header("Cache-Control", "no-store")
  @RequirePermissions("configs.manage")
  saveMailConfig(@Req() request: AdminRequest, @Body() input: unknown) {
    const body = asRecord(input);
    // Keep passwords verbatim; generic optionalString trims whitespace.
    return this.mailConfig.save(request.admin.sub, { api_url: body.api_url, delivery_method: body.delivery_method, smtp_host: body.smtp_host, smtp_port: body.smtp_port, smtp_security: body.smtp_security, mail_from: body.mail_from, password: body.password, status: body.status, revision: body.revision });
  }

  @Get("configs/credit-multipliers")
  @RequirePermissions("configs.manage")
  getCreditMultipliers() { return this.creditMultipliers.get(); }

  @Patch("configs/credit-multipliers")
  @RequirePermissions("configs.manage", "providers.manage")
  saveCreditMultipliers(@Req() request: AdminRequest, @Body() input: unknown) {
    const body = asRecord(input);
    return this.creditMultipliers.save(request.admin.sub, { multipliers: body.multipliers, revision: body.revision });
  }

  @Patch("configs/credit-pricing")
  @RequirePermissions("configs.manage", "providers.manage")
  saveCreditPricingConfig(@Req() request: AdminRequest, @Body() input: unknown) {
    const body = asRecord(input);
    return this.creditPricing.save(request.admin.sub, { cny_per_credit: body.cny_per_credit, auto_sync: body.auto_sync, revision: body.revision });
  }

  @Post("configs/credit-pricing/sync")
  @RequirePermissions("configs.manage", "providers.manage")
  syncCreditPricing(@Req() request: AdminRequest) { return this.creditPricing.syncAll(request.admin.sub); }

  @Post("providers/:providerId/pricing/sync")
  @RequirePermissions("providers.manage")
  refreshProviderPricing(@Req() request: AdminRequest, @Param("providerId") providerId: string) {
    return this.creditPricing.refreshProvider(request.admin.sub, providerId);
  }

  @Get("providers/default-model-config")
  @RequirePermissions("providers.manage")
  getDefaultModelConfig() {
    return this.admin.getDefaultModelConfig();
  }

  @Patch("providers/default-model-config")
  @RequirePermissions("providers.manage")
  updateDefaultModelConfig(@Req() request: AdminRequest, @Body() input: unknown) {
    const body = asRecord(input);
    return this.admin.updateDefaultModelConfig(request.admin.sub, {
      textModelId: requiredString(body, "text_model_id", 36),
      videoUnderstandingModelId: requiredString(body, "video_understanding_model_id", 36),
      imageModelIds: this.modelIdArray(body, "image_model_ids"),
      videoModelIds: this.modelIdArray(body, "video_model_ids"),
    });
  }

  @Post("providers")
  @RequirePermissions("providers.manage")
  createProvider(@Req() request: AdminRequest, @Body() input: unknown) {
    const body = asRecord(input);
    return this.admin.createProvider(request.admin.sub, {
      code: requiredString(body, "code", 64),
      displayName: requiredString(body, "display_name", 100),
      adapterType: requiredString(body, "adapter_type", 64),
      baseUrl: requiredString(body, "base_url", 500),
      status: optionalString(body, "status", 32),
      config: body.config,
    });
  }

  @Patch("providers/:providerId")
  @RequirePermissions("providers.manage")
  updateProvider(@Req() request: AdminRequest, @Param("providerId") providerId: string, @Body() input: unknown) {
    const body = asRecord(input);
    return this.admin.updateProvider(request.admin.sub, providerId, {
      code: optionalString(body, "code", 64),
      displayName: optionalString(body, "display_name", 100),
      adapterType: optionalString(body, "adapter_type", 64),
      baseUrl: optionalString(body, "base_url", 500),
      status: optionalString(body, "status", 32),
      config: body.config,
    });
  }

  @Get("providers/:providerId/credentials")
  @RequirePermissions("providers.manage")
  listProviderCredentials(@Param("providerId") providerId: string) {
    return this.admin.listProviderCredentials(providerId);
  }

  @Get("providers/:providerId/pricing")
  @Header("Cache-Control", "no-store")
  @RequirePermissions("providers.manage")
  getProviderPricing(@Param("providerId") providerId: string) {
    return this.providerPricing.query(providerId);
  }

  @Post("providers/:providerId/credentials")
  @RequirePermissions("providers.manage")
  createProviderCredential(@Req() request: AdminRequest, @Param("providerId") providerId: string, @Body() input: unknown) {
    const body = asRecord(input);
    return this.admin.createProviderCredential(request.admin.sub, providerId, {
      name: requiredString(body, "name", 100),
      apiKey: requiredString(body, "api_key", 500),
      status: optionalString(body, "status", 32),
      balance: body.balance === undefined || body.balance === null || body.balance === "" ? undefined : Number(body.balance),
      balanceCurrency: optionalString(body, "balance_currency", 32),
      notes: optionalString(body, "notes", 1000),
    });
  }

  @Patch("providers/:providerId/credentials/:credentialId")
  @RequirePermissions("providers.manage")
  updateProviderCredential(
    @Req() request: AdminRequest,
    @Param("providerId") providerId: string,
    @Param("credentialId") credentialId: string,
    @Body() input: unknown,
  ) {
    const body = asRecord(input);
    return this.admin.updateProviderCredential(request.admin.sub, providerId, credentialId, {
      name: optionalString(body, "name", 100),
      apiKey: optionalString(body, "api_key", 500),
      status: optionalString(body, "status", 32),
      balance: body.balance === undefined || body.balance === null || body.balance === "" ? undefined : Number(body.balance),
      balanceCurrency: optionalString(body, "balance_currency", 32),
      notes: optionalString(body, "notes", 1000),
    });
  }

  @Get("providers/:providerId/models")
  @RequirePermissions("providers.manage")
  listProviderModels(@Param("providerId") providerId: string) {
    return this.admin.listProviderModels(providerId);
  }

  @Post("providers/:providerId/models")
  @RequirePermissions("providers.manage")
  createProviderModel(@Req() request: AdminRequest, @Param("providerId") providerId: string, @Body() input: unknown) {
    return this.admin.createProviderModel(request.admin.sub, providerId, this.providerModelInput(asRecord(input)));
  }

  @Patch("providers/:providerId/models/:modelId")
  @RequirePermissions("providers.manage")
  updateProviderModel(
    @Req() request: AdminRequest,
    @Param("providerId") providerId: string,
    @Param("modelId") modelId: string,
    @Body() input: unknown,
  ) {
    return this.admin.updateProviderModel(request.admin.sub, providerId, modelId, this.providerModelInput(asRecord(input)));
  }

  @Post("providers/:providerId/models/:modelId/tests")
  @RequirePermissions("providers.manage")
  createModelTest(
    @Req() request: AdminRequest,
    @Param("providerId") providerId: string,
    @Param("modelId") modelId: string,
    @Body() input: unknown,
  ) {
    const body = asRecord(input);
    return this.modelTests.create(request.admin.sub, providerId, modelId, {
      credentialId: optionalString(body, "credential_id", 36),
      payload: jsonValue(body, "payload"),
    });
  }

  @Get("model-tests")
  @RequirePermissions("providers.manage")
  listModelTests(@Query("limit") limit?: string) {
    return this.modelTests.list(limit);
  }

  @Post("model-tests/:testId/query")
  @RequirePermissions("providers.manage")
  queryModelTest(@Req() request: AdminRequest, @Param("testId") testId: string) {
    return this.modelTests.query(request.admin.sub, testId);
  }

  @Get("credits/packages")
  @RequirePermissions("credits.manage")
  listCreditPackages() {
    return this.credits.listPackages();
  }

  @Post("credits/packages")
  @RequirePermissions("credits.manage")
  createCreditPackage(@Req() request: AdminRequest, @Body() input: unknown) {
    return this.credits.createPackage(request.admin.sub, this.creditPackageInput(asRecord(input)));
  }

  @Patch("credits/packages/:packageId")
  @RequirePermissions("credits.manage")
  updateCreditPackage(@Req() request: AdminRequest, @Param("packageId") packageId: string, @Body() input: unknown) {
    return this.credits.updatePackage(request.admin.sub, packageId, this.creditPackageInput(asRecord(input)));
  }

  @Delete("credits/packages/:packageId")
  @RequirePermissions("credits.manage")
  deleteCreditPackage(@Req() request: AdminRequest, @Param("packageId") packageId: string) {
    return this.credits.deletePackage(request.admin.sub, packageId);
  }

  @Get("credits/purchases")
  @RequirePermissions("credits.manage")
  listCreditPurchases(@Query("limit") limit?: string) {
    return this.credits.listPurchases(limit);
  }

  @Post("credits/purchases")
  @RequirePermissions("credits.manage")
  createCreditPurchase(@Req() request: AdminRequest, @Body() input: unknown) {
    return this.credits.createPurchase(request.admin.sub, this.creditPurchaseInput(asRecord(input)));
  }

  @Patch("credits/purchases/:purchaseId")
  @RequirePermissions("credits.manage")
  updateCreditPurchase(@Req() request: AdminRequest, @Param("purchaseId") purchaseId: string, @Body() input: unknown) {
    return this.credits.updatePurchase(request.admin.sub, purchaseId, this.creditPurchaseInput(asRecord(input)));
  }

  @Delete("credits/purchases/:purchaseId")
  @RequirePermissions("credits.manage")
  deleteCreditPurchase(@Req() request: AdminRequest, @Param("purchaseId") purchaseId: string) {
    return this.credits.deletePurchase(request.admin.sub, purchaseId);
  }

  @Get("credits/consumptions")
  @RequirePermissions("credits.manage")
  listCreditConsumptions(@Query("limit") limit?: string) {
    return this.credits.listConsumptions(limit);
  }

  @Post("credits/consumptions")
  @RequirePermissions("credits.manage")
  createCreditConsumption(@Req() request: AdminRequest, @Body() input: unknown) {
    return this.credits.createConsumption(request.admin.sub, this.creditConsumptionInput(asRecord(input)));
  }

  @Patch("credits/consumptions/:consumptionId")
  @RequirePermissions("credits.manage")
  updateCreditConsumption(@Req() request: AdminRequest, @Param("consumptionId") consumptionId: string, @Body() input: unknown) {
    return this.credits.updateConsumption(request.admin.sub, consumptionId, this.creditConsumptionInput(asRecord(input)));
  }

  @Delete("credits/consumptions/:consumptionId")
  @RequirePermissions("credits.manage")
  deleteCreditConsumption(@Req() request: AdminRequest, @Param("consumptionId") consumptionId: string) {
    return this.credits.deleteConsumption(request.admin.sub, consumptionId);
  }

  private creditPackageInput(body: Record<string, unknown>) {
    return {
      code: requiredString(body, "code", 64),
      name: requiredString(body, "name", 100),
      description: optionalString(body, "description", 500),
      baseCredits: Number(body.base_credits),
      bonusCredits: Number(body.bonus_credits),
      priceFen: Number(body.price_fen),
      currency: optionalString(body, "currency", 3) || "CNY",
      status: optionalString(body, "status", 32) || "ACTIVE",
      sortOrder: Number(body.sort_order),
    };
  }

  private catalogCategoryInput(body: Record<string, unknown>) {
    return {
      code: requiredString(body, "code", 64),
      name: requiredString(body, "name", 100),
      description: optionalString(body, "description", 500),
      sortOrder: Number(body.sort_order ?? 0),
      status: optionalString(body, "status", 32) || "ACTIVE",
    };
  }

  private creditPurchaseInput(body: Record<string, unknown>) {
    return {
      userId: requiredString(body, "user_id", 36),
      packageId: requiredString(body, "package_id", 36),
      creditsGranted: body.credits_granted === undefined || body.credits_granted === "" ? undefined : Number(body.credits_granted),
      paidAmountFen: body.paid_amount_fen === undefined || body.paid_amount_fen === "" ? undefined : Number(body.paid_amount_fen),
      currency: optionalString(body, "currency", 3),
      paymentOrderId: optionalString(body, "payment_order_id", 36) || null,
      status: optionalString(body, "status", 32) || "CREATED",
      purchasedAt: optionalString(body, "purchased_at", 64) || null,
      notes: optionalString(body, "notes", 1000),
    };
  }

  private creditConsumptionInput(body: Record<string, unknown>) {
    return {
      userId: requiredString(body, "user_id", 36),
      taskId: optionalString(body, "task_id", 36) || null,
      providerModelId: optionalString(body, "provider_model_id", 36) || null,
      category: optionalString(body, "category", 64) || "MODEL_TASK",
      creditsConsumed: Number(body.credits_consumed),
      status: optionalString(body, "status", 32) || "CONFIRMED",
      description: optionalString(body, "description", 500),
      notes: optionalString(body, "notes", 1000),
      metadata: body.metadata,
      occurredAt: optionalString(body, "occurred_at", 64) || null,
    };
  }

  private providerModelInput(body: Record<string, unknown>) {
    return {
      modelCode: requiredString(body, "model_code", 191),
      displayName: requiredString(body, "display_name", 100),
      modelAlias: requiredString(body, "model_alias", 100),
      capability: requiredString(body, "capability", 64),
      apiProtocol: requiredString(body, "api_protocol", 64),
      generationEndpoint: requiredString(body, "generation_endpoint", 500),
      queryEndpoint: optionalString(body, "query_endpoint", 500) || null,
      creditCost: Number(body.credit_cost),
      maxReferenceImages: Number(body.max_reference_images),
      supportsReferenceVideo: body.supports_reference_video === true,
      supportsRealPerson: body.supports_real_person === true,
      supportsAsyncTasks: body.supports_async_tasks === true,
      sortOrder: Number(body.sort_order),
      description: optionalString(body, "description", 1000),
      status: optionalString(body, "status", 32),
      parameterSchema: body.parameter_schema,
      config: body.config,
      resolutionPrices: this.resolutionPrices(body),
    };
  }

  private resolutionPrices(body: Record<string, unknown>): Array<{ resolution: string; creditCost: number }> {
    const value = body.resolution_prices;
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new BadRequestException("resolution_prices 必须是数组");
    return value.map((item) => {
      const row = asRecord(item);
      return { resolution: requiredString(row, "resolution", 32), creditCost: Number(row.credit_cost) };
    });
  }

  private modelIdArray(body: Record<string, unknown>, field: string): string[] {
    const value = body[field];
    if (!Array.isArray(value)) throw new BadRequestException(`${field} 必须是数组`);
    if (value.length > 500 || value.some((item) => typeof item !== "string" || !/^[A-Za-z0-9-]{1,36}$/.test(item))) {
      throw new BadRequestException(`${field} 包含无效模型 ID`);
    }
    return [...new Set(value)];
  }

  @Get("users")
  @RequirePermissions("users.read")
  @Header("Cache-Control", "no-store")
  listUsers(@Query("limit") limit?: string) {
    return this.admin.listUsers(limit);
  }

  @Get("users/:userId/relations")
  @RequirePermissions("users.read")
  @Header("Cache-Control", "no-store")
  userRelations(@Param("userId") userId: string, @Query("level") level?: string, @Query("page") page?: string) {
    return this.admin.userRelations(userId, level, page);
  }

  @Patch("users/:userId")
  @RequirePermissions("users.manage")
  updateUser(@Req() request: AdminRequest, @Param("userId") userId: string, @Body() input: unknown) {
    const body = asRecord(input);
    return this.admin.updateUser(request.admin.sub, userId, {
      displayName: requiredString(body, "display_name", 100),
      email: this.nullableString(body, "email", 191),
      phone: this.nullableString(body, "phone", 32),
      avatarUrl: this.nullableString(body, "avatar_url", 1000),
      bio: optionalString(body, "bio", 500) || "",
      status: requiredString(body, "status", 32),
    });
  }

  @Post("users/:userId/credit-adjustments")
  @RequirePermissions("users.manage", "credits.manage")
  adjustUserCredits(@Req() request: AdminRequest, @Param("userId") userId: string, @Body() input: unknown) {
    const body = asRecord(input);
    return this.admin.adjustUserCredits(request.admin.sub, userId, {
      amount: Number(body.amount),
      reason: requiredString(body, "reason", 500),
    });
  }

  @Get("tasks")
  @RequirePermissions("tasks.read")
  listTasks(@Query("limit") limit?: string) {
    return this.admin.listTasks(limit);
  }

  @Get("payments")
  @RequirePermissions("payments.read")
  listPayments(@Query("limit") limit?: string) {
    return this.admin.listPayments(limit);
  }

  @Get("audit-logs")
  @RequirePermissions("audit.read")
  listAuditLogs(@Query("limit") limit?: string) {
    return this.admin.listAuditLogs(limit);
  }

  private nullableString(body: Record<string, unknown>, field: string, maxLength: number): string | null {
    const value = body[field];
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string") throw new BadRequestException(`${field} 必须是字符串`);
    const normalized = value.trim();
    if (normalized.length > maxLength) throw new BadRequestException(`${field} 内容过长`);
    return normalized || null;
  }
}
