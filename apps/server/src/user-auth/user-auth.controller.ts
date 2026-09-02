import { BadRequestException, Body, Controller, Get, Header, HttpCode, Inject, Patch, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { asRecord, optionalString, requiredString } from "../common/input";
import { UserAuthGuard, UserRequest } from "./user-auth.guard";
import { UserAuthService } from "./user-auth.service";
import { RegistrationVerificationService } from "./registration-verification.service";

@Controller()
export class UserAuthController {
  constructor(
    @Inject(UserAuthService) private readonly auth: UserAuthService,
    @Inject(RegistrationVerificationService) private readonly registration: RegistrationVerificationService,
  ) {}

  @Post("auth/email/status")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  emailStatus(@Body() input: unknown, @Req() request: Request) {
    return this.registration.emailStatus(requiredString(asRecord(input), "email", 191), request.ip || request.socket.remoteAddress || "unknown");
  }

  @Post("auth/register/email/captcha")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  createEmailCaptcha(@Body() input: unknown, @Req() request: Request) {
    return this.registration.createCaptcha(requiredString(asRecord(input), "email", 191), request.ip || request.socket.remoteAddress || "unknown");
  }

  @Post("auth/register/email/captcha/verify")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  verifyEmailCaptcha(@Body() input: unknown, @Req() request: Request) {
    const body = asRecord(input);
    return this.registration.verifyCaptcha(requiredString(body, "email", 191), requiredString(body, "captcha_id", 36), requiredString(body, "answer", 10), request.ip || request.socket.remoteAddress || "unknown");
  }

  @Post("auth/register/email/code")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  sendEmailCode(@Body() input: unknown, @Req() request: Request) {
    const body = asRecord(input);
    return this.registration.sendEmailCode(requiredString(body, "email", 191), requiredString(body, "captcha_token", 100), request.ip || request.socket.remoteAddress || "unknown");
  }

  @Post("auth/register/email")
  registerEmail(@Body() input: unknown, @Req() request: Request) { const body = asRecord(input); return this.auth.registerEmail(requiredString(body, "email", 191), requiredString(body, "password", 128), requiredString(body, "email_code", 6), optionalString(body, "display_name", 100), request.ip || request.socket.remoteAddress || "unknown", optionalString(body, "invite_code", 8)); }

  @Post("auth/register/phone")
  registerPhone(@Body() input: unknown) { const body = asRecord(input); return this.auth.registerPhone(requiredString(body, "phone", 32), requiredString(body, "password", 128), optionalString(body, "display_name", 100)); }

  @Post("auth/login")
  login(@Body() input: unknown) { const body = asRecord(input); return this.auth.login(requiredString(body, "identifier", 191), requiredString(body, "password", 128), optionalString(body, "device_name", 100)); }

  @Post("auth/refresh")
  refresh(@Body() input: unknown) { const body = asRecord(input); return this.auth.refresh(requiredString(body, "refresh_token", 200), optionalString(body, "device_name", 100)); }

  @Post("auth/logout")
  @UseGuards(UserAuthGuard)
  logout(@Req() request: UserRequest) { return this.auth.logout(request.user); }

  @Post("auth/wechat/qr-sessions")
  createWechatQrSession(@Body() input?: unknown) { return this.auth.createWechatQrSession(optionalString(asRecord(input || {}), "invite_code", 8)); }

  @Get("auth/wechat/events")
  async verifyWechatOfficialAccount(
    @Query("signature") signature: string, @Query("timestamp") timestamp: string, @Query("nonce") nonce: string,
    @Query("echostr") echo: string, @Query("msg_signature") messageSignature: string | undefined,
    @Query("encrypt_type") encryptType: string | undefined, @Res() response: Response,
  ) {
    const result = await this.auth.verifyOfficialAccountServer(signature, timestamp, nonce, echo, messageSignature, encryptType === "aes");
    response.type("text/plain").send(result);
  }

  @Post("auth/wechat/events")
  @HttpCode(200)
  async receiveWechatOfficialAccountEvent(
    @Query("signature") signature: string, @Query("timestamp") timestamp: string, @Query("nonce") nonce: string,
    @Query("msg_signature") messageSignature: string | undefined, @Query("encrypt_type") encryptType: string | undefined,
    @Body() body: unknown, @Res() response: Response,
  ) {
    if (typeof body !== "string") throw new BadRequestException("公众号事件正文必须是 XML");
    const result = await this.auth.handleOfficialAccountEvent({ signature, timestamp, nonce, messageSignature, encrypted: encryptType === "aes", body });
    response.type("text/plain").send(result);
  }

  @Get("auth/wechat/qr-sessions/status")
  pollWechatSession(@Query("state") state: string, @Query("device_name") deviceName?: string) { return this.auth.pollWechatSession(state, deviceName); }

  @Get("users/me")
  @UseGuards(UserAuthGuard)
  me(@Req() request: UserRequest) { return this.auth.profile(request.user.sub); }

  @Patch("users/me")
  @UseGuards(UserAuthGuard)
  updateMe(@Req() request: UserRequest, @Body() input: unknown) {
    const body = asRecord(input);
    return this.auth.updateProfile(request.user.sub, {
      displayName: optionalString(body, "display_name", 100),
      avatarUrl: body.avatar_url === null ? null : optionalString(body, "avatar_url", 1000),
      bio: optionalString(body, "bio", 500),
      email: body.email === null ? "" : optionalString(body, "email", 191),
      phone: body.phone === null ? "" : optionalString(body, "phone", 32),
      currentPassword: optionalString(body, "current_password", 128),
      newPassword: optionalString(body, "new_password", 128),
    });
  }
}
