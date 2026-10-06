import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { TutorialsModule } from "../tutorials/tutorials.module";
import { ViralRemakesAdminController, ViralRemakesController } from "./viral-remakes.controller";
import { ViralRemakesService } from "./viral-remakes.service";

@Module({
  imports: [AuthModule, TutorialsModule],
  controllers: [ViralRemakesController, ViralRemakesAdminController],
  providers: [ViralRemakesService],
})
export class ViralRemakesModule {}
