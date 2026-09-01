import { Injectable } from "@nestjs/common";
import { AppConfig, loadAppConfig } from "./environment";

@Injectable()
export class EnvironmentService {
  readonly values: AppConfig = loadAppConfig();
}
