import { Global, Module } from "@nestjs/common";
import { AuditService } from "./audit.service";
import { SecretCryptoService } from "./secret-crypto.service";
import { ModelCreditMultiplierService } from "./model-credit-multiplier.service";
import { WagaModelMetadataService } from "./waga-model-metadata.service";

@Global()
@Module({ providers: [AuditService, SecretCryptoService, ModelCreditMultiplierService, WagaModelMetadataService], exports: [AuditService, SecretCryptoService, ModelCreditMultiplierService, WagaModelMetadataService] })
export class CommonModule {}
