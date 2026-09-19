@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul

pushd "%~dp0" >nul || exit /b 1

set "DESKTOP_DIR=%CD%\apps\desktop"
set "PRODUCTION_ENV=%DESKTOP_DIR%\.env.production"
set "PRIVATE_CONFIG=src-tauri/tauri.private-test.conf.json"
set "OUTPUT_DIR=%DESKTOP_DIR%\src-tauri\target\release\bundle\nsis"

if not exist "%PRODUCTION_ENV%" (
  echo [ERROR] Missing production config: %PRODUCTION_ENV%
  goto :failed
)

where npm.cmd >nul 2>&1 || (
  echo [ERROR] npm was not found. Install Node.js first.
  goto :failed
)
where rustc.exe >nul 2>&1 || (
  echo [ERROR] rustc was not found. Install the Rust MSVC toolchain first.
  goto :failed
)
where cargo.exe >nul 2>&1 || (
  echo [ERROR] cargo was not found. Install the Rust MSVC toolchain first.
  goto :failed
)
where python.exe >nul 2>&1 || (
  echo [ERROR] python was not found. Install Python and the Worker dependencies first.
  goto :failed
)

if not exist "%CD%\node_modules\.bin\tauri.cmd" (
  echo [ERROR] Project dependencies are missing. Run npm install in the project root first.
  goto :failed
)

for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%PRODUCTION_ENV%") do (
  if not "%%A"=="" set "%%A=%%B"
)

set "NODE_ENV=production"
if not defined VITE_PLATFORM_API_URL (
  echo [ERROR] VITE_PLATFORM_API_URL is missing from .env.production.
  goto :failed
)
if not defined AIVS_UPDATER_PUBLIC_KEY (
  echo [ERROR] AIVS_UPDATER_PUBLIC_KEY is missing from .env.production.
  goto :failed
)

echo [INFO] Building an unsigned private-test NSIS installer...
call npm run tauri:build --workspace @aivs/desktop -- --bundles nsis --no-sign --config "%PRIVATE_CONFIG%"
if errorlevel 1 goto :failed

echo.
echo [SUCCESS] Private-test installer build completed.
echo [OUTPUT] %OUTPUT_DIR%
echo [WARNING] This installer is for direct testing only and cannot be published as an online update.
goto :success

:failed
set "BUILD_EXIT_CODE=%ERRORLEVEL%"
if "%BUILD_EXIT_CODE%"=="0" set "BUILD_EXIT_CODE=1"
echo.
echo [FAILED] Private-test installer build did not complete.
popd >nul
endlocal & exit /b %BUILD_EXIT_CODE%

:success
popd >nul
endlocal & exit /b 0
