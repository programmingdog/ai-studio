import { Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module";
import { ClientConfigController } from "./client-config.controller";
import { ClientConfigService } from "./client-config.service";

@Module({ imports: [CatalogModule], controllers: [ClientConfigController], providers: [ClientConfigService] })
export class ClientConfigModule {}
