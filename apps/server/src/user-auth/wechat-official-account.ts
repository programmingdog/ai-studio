import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { createDecipheriv, createHash } from "node:crypto";

function sha1(values: string[]): string {
  return createHash("sha1").update([...values].sort().join(""), "utf8").digest("hex");
}

export function verifyWechatMessageSignature(token: string, timestamp: string, nonce: string, signature: string, encrypted?: string): void {
  if (!token || !timestamp || !nonce || !signature) throw new UnauthorizedException("公众号消息签名参数不完整");
  const expected = sha1(encrypted ? [token, timestamp, nonce, encrypted] : [token, timestamp, nonce]);
  if (expected !== signature.toLowerCase()) throw new UnauthorizedException("公众号消息签名验证失败");
}

export function xmlValue(xml: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`<${escaped}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))<\\/${escaped}>`, "i"));
  return (match?.[1] ?? match?.[2] ?? "")
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&").trim();
}

export function decryptWechatMessage(encrypted: string, encodingAesKey: string, expectedAppId: string): string {
  if (!/^[A-Za-z0-9+/]{43}$/.test(encodingAesKey)) throw new BadRequestException("公众号 EncodingAESKey 配置无效");
  let plain: Buffer;
  try {
    const key = Buffer.from(`${encodingAesKey}=`, "base64");
    const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
    decipher.setAutoPadding(false);
    plain = Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]);
  } catch {
    throw new UnauthorizedException("公众号加密消息解密失败");
  }
  const padding = plain[plain.length - 1] || 0;
  if (padding < 1 || padding > 32) throw new UnauthorizedException("公众号加密消息填充无效");
  const unpadded = plain.subarray(0, plain.length - padding);
  if (unpadded.length < 20) throw new UnauthorizedException("公众号加密消息长度无效");
  const messageLength = unpadded.readUInt32BE(16);
  const messageEnd = 20 + messageLength;
  if (messageEnd > unpadded.length) throw new UnauthorizedException("公众号加密消息正文长度无效");
  const appId = unpadded.subarray(messageEnd).toString("utf8");
  if (appId !== expectedAppId) throw new UnauthorizedException("公众号加密消息 AppID 不匹配");
  return unpadded.subarray(20, messageEnd).toString("utf8");
}
