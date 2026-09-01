import { ServiceUnavailableException } from "@nestjs/common";

/** The request may already have sent mail; never treat this as a confirmed rejection. */
export class MailDeliveryUnconfirmedException extends ServiceUnavailableException {
  constructor(diagnosticId: string) {
    super({ statusCode: 503, code: "MAIL_HTTP_DELIVERY_UNCONFIRMED", delivery_status: "UNCERTAIN", diagnostic_id: diagnosticId,
      message: "邮件发送结果暂未确认，邮件可能已送达。若已收到本次验证码，可直接填写并注册；未收到请稍候检查垃圾邮件，重发仍需重新进行图形验证。" });
  }
}
