import { Module } from "@nestjs/common";
import { UserAuthModule } from "../user-auth/user-auth.module";
import { CreditsController } from "./credits.controller";
import { CreditsService } from "./credits.service";
import { ReferralsModule } from "../referrals/referrals.module";

@Module({ imports: [UserAuthModule, ReferralsModule], controllers: [CreditsController], providers: [CreditsService], exports: [CreditsService] })
export class CreditsModule {}
