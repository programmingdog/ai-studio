import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { asRecord, requiredString } from "../common/input";
import { UserAuthGuard, UserRequest } from "../user-auth/user-auth.guard";
import { CreditsService } from "./credits.service";

type RawBodyRequest = Request & { rawBody?: Buffer };

@Controller()
export class CreditsController {
  constructor(@Inject(CreditsService) private readonly credits: CreditsService) {}

  @Get("credits/packages")
  packages() { return this.credits.packages(); }

  @Get("credits/balance")
  @UseGuards(UserAuthGuard)
  balance(@Req() request: UserRequest) { return this.credits.balance(request.user.sub); }

  @Get("credits/purchases")
  @UseGuards(UserAuthGuard)
  purchases(@Req() request: UserRequest) { return this.credits.purchases(request.user.sub); }

  @Get("credits/consumptions")
  @UseGuards(UserAuthGuard)
  consumptions(@Req() request: UserRequest) { return this.credits.consumptions(request.user.sub); }

  @Post("credits/purchases")
  @UseGuards(UserAuthGuard)
  createPurchase(@Req() request: UserRequest, @Body() input: unknown) {
    const body = asRecord(input);
    return this.credits.createPurchase(request.user.sub, requiredString(body, "package_id", 36), requiredString(body, "idempotency_key", 191));
  }

  @Get("credits/purchases/:purchaseId")
  @UseGuards(UserAuthGuard)
  purchase(@Req() request: UserRequest, @Param("purchaseId") purchaseId: string) { return this.credits.purchase(request.user.sub, purchaseId); }

  @Post("payments/wechat/notify")
  notify(@Req() request: RawBodyRequest) { return this.credits.handleWechatNotification(request.headers, request.rawBody?.toString("utf8") || ""); }
}
