import { Inject, Injectable } from "@nestjs/common";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { EnvironmentService } from "../config/environment.service";

@Injectable()
export class SecretCryptoService {
  private readonly key: Buffer;

  constructor(@Inject(EnvironmentService) environment: EnvironmentService) {
    this.key = createHash("sha256").update(environment.values.credentialEncryptionKey).digest();
  }

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(":");
  }

  decrypt(payload: string): string {
    const [version, iv, tag, ciphertext] = payload.split(":");
    if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Unsupported encrypted secret format");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  }

  mask(value: string): string {
    if (value.length <= 10) return `${value.slice(0, 2)}••••${value.slice(-2)}`;
    return `${value.slice(0, 6)}••••••${value.slice(-4)}`;
  }
}
