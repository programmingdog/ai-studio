import { Global, Module } from "@nestjs/common";
import { AuditService } from "./audit.service";
import { SecretCryptoService } from "./secret-crypto.service";
import { ModelCreditMultiplierService } from "./model-credit-multiplier.service";
import { WagaModelMetadataService } from "./waga-model-metadata.service";
import { AuthMethodConfigService } from "./auth-method-config.service";
import { IpAccessControlService } from "./ip-access-control.service";
import { ProductBrandConfigService } from "./product-brand-config.service";

@Global()
@Module({ providers: [AuditService, SecretCryptoService, ModelCreditMultiplierService, WagaModelMetadataService, AuthMethodConfigService, IpAccessControlService, ProductBrandConfigService], exports: [AuditService, SecretCryptoService, ModelCreditMultiplierService, WagaModelMetadataService, AuthMethodConfigService, IpAccessControlService, ProductBrandConfigService] })
export class CommonModule {}
