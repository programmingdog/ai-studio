; Preserve the original installation when the product display name changes.
; Tauri's NSIS template keys its install directory and uninstall registration by
; productName, so changing 影匠 to 逐梦帧 would otherwise create a second app.

Var LegacyProductName
Var LegacyInstallDir
Var LegacyMainBinaryName
Var ExistingRenamedInstallDir
Var LegacyDesktopShortcut
Var LegacyStartMenuShortcut
Var RenamedDesktopShortcut
Var RenamedStartMenuShortcut

!macro DetectLegacyInstall LEGACY_NAME
  ${If} $LegacyInstallDir == ""
    ReadRegStr $R8 SHCTX "Software\aivideo\${LEGACY_NAME}" ""
    ${If} $R8 != ""
    ${AndIf} ${FileExists} "$R8\uninstall.exe"
      StrCpy $LegacyProductName "${LEGACY_NAME}"
      StrCpy $LegacyInstallDir $R8
      ReadRegStr $LegacyMainBinaryName SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\${LEGACY_NAME}" "MainBinaryName"
      ${If} $LegacyMainBinaryName == ""
        StrCpy $LegacyMainBinaryName "ai-video-studio.exe"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  StrCpy $LegacyProductName ""
  StrCpy $LegacyInstallDir ""
  StrCpy $LegacyMainBinaryName ""
  StrCpy $ExistingRenamedInstallDir $INSTDIR
  StrCpy $LegacyDesktopShortcut 0
  StrCpy $LegacyStartMenuShortcut 0
  StrCpy $RenamedDesktopShortcut 0
  StrCpy $RenamedStartMenuShortcut 0

  !insertmacro DetectLegacyInstall "影匠"
  !insertmacro DetectLegacyInstall "AI Video Studio"

  ${If} $LegacyInstallDir != ""
    IfFileExists "$DESKTOP\$LegacyProductName.lnk" 0 +2
      StrCpy $LegacyDesktopShortcut 1
    IfFileExists "$SMPROGRAMS\$LegacyProductName.lnk" 0 +2
      StrCpy $LegacyStartMenuShortcut 1
    IfFileExists "$DESKTOP\${PRODUCTNAME}.lnk" 0 +2
      StrCpy $RenamedDesktopShortcut 1
    IfFileExists "$SMPROGRAMS\${PRODUCTNAME}.lnk" 0 +2
      StrCpy $RenamedStartMenuShortcut 1

    ; Manual installs can run while the legacy executable is still open.
    !insertmacro CheckIfAppIsRunning "$LegacyMainBinaryName" "$LegacyProductName"

    ; If a prior renamed release was installed side by side, remove only its
    ; application files in update mode. /UPDATE preserves app data and shortcuts.
    ${If} $ExistingRenamedInstallDir != $LegacyInstallDir
    ${AndIf} ${FileExists} "$ExistingRenamedInstallDir\uninstall.exe"
      ExecWait '"$ExistingRenamedInstallDir\uninstall.exe" /UPDATE /P _?=$ExistingRenamedInstallDir' $R9
      ${If} $R9 != 0
        Abort "无法清理重复安装的逐梦帧（退出码 $R9），请关闭程序后重试。"
      ${EndIf}
    ${EndIf}

    ; SetOutPath appears immediately before this hook in Tauri's NSIS template,
    ; therefore it must be repeated after changing $INSTDIR.
    StrCpy $INSTDIR $LegacyInstallDir
    SetOutPath $INSTDIR
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $LegacyInstallDir != ""
    ${If} $LegacyMainBinaryName != ""
    ${AndIf} $LegacyMainBinaryName != "${MAINBINARYNAME}.exe"
      Delete "$INSTDIR\$LegacyMainBinaryName"
    ${EndIf}

    ; Replace legacy shortcuts only when they existed before migration.
    Delete "$DESKTOP\$LegacyProductName.lnk"
    Delete "$SMPROGRAMS\$LegacyProductName.lnk"
    ${If} $LegacyDesktopShortcut = 1
    ${OrIf} $RenamedDesktopShortcut = 1
      CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    ${EndIf}
    ${If} $LegacyStartMenuShortcut = 1
    ${OrIf} $RenamedStartMenuShortcut = 1
      CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    ${EndIf}

    ; The new installer has already written the 逐梦帧 entries at this point.
    DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\$LegacyProductName"
    DeleteRegKey SHCTX "Software\aivideo\$LegacyProductName"
    DeleteRegKey HKCU "Software\aivideo\$LegacyProductName"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "$LegacyProductName"
  ${EndIf}
!macroend
