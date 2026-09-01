import { Body, Controller, Get, Header, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { UserAuthGuard, UserRequest } from "../user-auth/user-auth.guard";
import { asRecord } from "../common/input";
import { ReferralsService } from "./referrals.service";

@Controller("referrals")
export class ReferralsController {
  constructor(@Inject(ReferralsService) private readonly referrals: ReferralsService) {}
  @Get("invitations/:code")
  @Header("Cache-Control", "no-store")
  invitation(@Param("code") code: string) { return this.referrals.publicInvitation(code); }
  @Get("me")
  @UseGuards(UserAuthGuard)
  @Header("Cache-Control", "no-store")
  me(@Req() req: UserRequest) { return this.referrals.summary(req.user.sub); }
  @Get("me/:kind")
  @UseGuards(UserAuthGuard)
  @Header("Cache-Control", "no-store")
  records(@Req() req: UserRequest, @Param("kind") kind: string, @Query("page") page?: string) { return this.referrals.records(kind, req.user.sub, page); }
  @Post("withdrawals")
  @UseGuards(UserAuthGuard)
  @Header("Cache-Control", "no-store")
  apply(@Req() req: UserRequest, @Body() input: unknown) { return this.referrals.applyWithdrawal(req.user.sub, asRecord(input)); }
}
