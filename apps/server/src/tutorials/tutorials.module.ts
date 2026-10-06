import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { TutorialMediaService } from "./tutorial-media.service";
import { TutorialsAdminController, TutorialsController } from "./tutorials.controller";
import { TutorialsService } from "./tutorials.service";

@Module({
  imports: [AuthModule],
  controllers: [TutorialsController, TutorialsAdminController],
  providers: [TutorialsService, TutorialMediaService],
  exports: [TutorialMediaService],
})
export class TutorialsModule {}
