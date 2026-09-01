import { Module } from "@nestjs/common";
import { MailConfigService } from "./mail-config.service";

@Module({ providers: [MailConfigService], exports: [MailConfigService] })
export class MailModule {}
