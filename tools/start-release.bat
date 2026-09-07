@echo off
setlocal EnableExtensions DisableDelayedExpansion

pushd "%~dp0.." >nul || (
  echo [ERROR] Cannot enter the repository directory.
  exit /b 1
)

set "POWERSHELL_EXE="
where pwsh.exe >nul 2>&1 && set "POWERSHELL_EXE=pwsh.exe"
if not defined POWERSHELL_EXE if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not defined POWERSHELL_EXE (
  echo [ERROR] PowerShell was not found.
  goto :failed
)

set "RELEASE_VERSION="
set /p "RELEASE_VERSION=Enter the new client version, for example 0.2.1: "
if not defined RELEASE_VERSION (
  echo [ERROR] Version is required.
  goto :failed
)

"%POWERSHELL_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0release.ps1" -Stage All -Version "%RELEASE_VERSION%"
if errorlevel 1 goto :failed

echo.
echo [SUCCESS] Automated release v%RELEASE_VERSION% completed.
pause
popd >nul
endlocal & exit /b 0

:failed
set "RELEASE_EXIT_CODE=%ERRORLEVEL%"
if "%RELEASE_EXIT_CODE%"=="0" set "RELEASE_EXIT_CODE=1"
echo.
echo [FAILED] Automated release did not complete.
pause
popd >nul
endlocal & exit /b %RELEASE_EXIT_CODE%
