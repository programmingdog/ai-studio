import { Module } from "@nestjs/common";
import { UserAuthModule } from "../user-auth/user-auth.module";
import { ModelGatewayController } from "./model-gateway.controller";
import { ModelGatewayService } from "./model-gateway.service";

@Module({ imports: [UserAuthModule], controllers: [ModelGatewayController], providers: [ModelGatewayService] })
export class ModelGatewayModule {}
