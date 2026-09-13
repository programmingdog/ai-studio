@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
pushd "%~dp0" >nul || exit /b 1

set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
where pwsh.exe >nul 2>&1 && set "POWERSHELL_EXE=pwsh.exe"
if not exist "%POWERSHELL_EXE%" (
  echo [ERROR] PowerShell was not found.
  goto :failed
)

set "RELEASE_STAGE=ClientOnly"
if /i "%~1"=="--resume" set "RELEASE_STAGE=ResumeClient"
"%POWERSHELL_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\release.ps1" -Stage %RELEASE_STAGE%
if errorlevel 1 goto :failed

echo.
echo [SUCCESS] Client build, upload, and publication completed.
pause
popd >nul
endlocal & exit /b 0

:failed
set "RELEASE_EXIT_CODE=%ERRORLEVEL%"
if "%RELEASE_EXIT_CODE%"=="0" set "RELEASE_EXIT_CODE=1"
echo.
echo [FAILED] Client release did not complete.
pause
popd >nul
endlocal & exit /b %RELEASE_EXIT_CODE%
