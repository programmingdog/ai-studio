import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { UserAuthModule } from "../user-auth/user-auth.module";
import { ScriptLibraryAdminController, ScriptLibraryController } from "./script-library.controller";
import { ScriptLibraryService } from "./script-library.service";

@Module({ imports: [AuthModule, UserAuthModule], controllers: [ScriptLibraryController, ScriptLibraryAdminController], providers: [ScriptLibraryService] })
export class ScriptLibraryModule {}
