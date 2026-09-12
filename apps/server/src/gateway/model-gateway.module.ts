import { Module } from "@nestjs/common";
import { UserAuthModule } from "../user-auth/user-auth.module";
import { ModelGatewayController, TemporaryReferenceImageController } from "./model-gateway.controller";
import { ModelGatewayService } from "./model-gateway.service";
import { ReferralsModule } from "../referrals/referrals.module";

@Module({ imports: [UserAuthModule, ReferralsModule], controllers: [ModelGatewayController, TemporaryReferenceImageController], providers: [ModelGatewayService] })
export class ModelGatewayModule {}
