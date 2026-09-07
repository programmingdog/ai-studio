import { Global, Module } from "@nestjs/common";
import { AuditService } from "./audit.service";
import { SecretCryptoService } from "./secret-crypto.service";
import { WagaModelMetadataService } from "./waga-model-metadata.service";
import { AuthMethodConfigService } from "./auth-method-config.service";
import { IpAccessControlService } from "./ip-access-control.service";
import { ProductBrandConfigService } from "./product-brand-config.service";
import { DesktopReleaseService } from "./desktop-release.service";

@Global()
@Module({ providers: [AuditService, SecretCryptoService, WagaModelMetadataService, AuthMethodConfigService, IpAccessControlService, ProductBrandConfigService, DesktopReleaseService], exports: [AuditService, SecretCryptoService, WagaModelMetadataService, AuthMethodConfigService, IpAccessControlService, ProductBrandConfigService, DesktopReleaseService] })
export class CommonModule {}
