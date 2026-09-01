import { Module } from "@nestjs/common";
import { UserAuthController } from "./user-auth.controller";
import { UserAuthGuard } from "./user-auth.guard";
import { UserAuthService } from "./user-auth.service";
import { RegistrationMailService } from "./registration-mail.service";
import { RegistrationVerificationService } from "./registration-verification.service";
import { MailModule } from "../mail/mail.module";
import { ReferralsModule } from "../referrals/referrals.module";
import { ReferralsController } from "../referrals/referrals.controller";

@Module({ imports: [MailModule, ReferralsModule], controllers: [UserAuthController, ReferralsController], providers: [UserAuthService, UserAuthGuard, RegistrationMailService, RegistrationVerificationService], exports: [UserAuthService, UserAuthGuard] })
export class UserAuthModule {}
