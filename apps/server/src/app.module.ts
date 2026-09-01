import { Module } from "@nestjs/common";
import { AdminModule } from "./admin/admin.module";
import { AuthModule } from "./auth/auth.module";
import { ClientConfigModule } from "./client-config/client-config.module";
import { CommonModule } from "./common/common.module";
import { EnvironmentModule } from "./config/environment.module";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./health.controller";
import { UserAuthModule } from "./user-auth/user-auth.module";
import { CreditsModule } from "./credits/credits.module";
import { ModelGatewayModule } from "./gateway/model-gateway.module";

@Module({
  imports: [EnvironmentModule, DatabaseModule, CommonModule, AuthModule, UserAuthModule, CreditsModule, ModelGatewayModule, AdminModule, ClientConfigModule],
  controllers: [HealthController],
})
export class AppModule {}
