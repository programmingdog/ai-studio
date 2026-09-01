import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { CatalogModule } from "../catalog/catalog.module";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { CreditAdminService } from "./credit-admin.service";
import { ModelTestService } from "./model-test.service";
import { WechatPaymentConfigService } from "./wechat-payment-config.service";
import { ProviderPricingService } from "./provider-pricing.service";
import { CreditPricingService } from "./credit-pricing.service";
import { MailModule } from "../mail/mail.module";
import { ReferralsModule } from "../referrals/referrals.module";
import { ReferralsAdminController } from "../referrals/referrals-admin.controller";

@Module({ imports: [AuthModule, CatalogModule, MailModule, ReferralsModule], controllers: [AdminController, ReferralsAdminController], providers: [AdminService, CreditAdminService, ModelTestService, WechatPaymentConfigService, ProviderPricingService, CreditPricingService] })
export class AdminModule {}
