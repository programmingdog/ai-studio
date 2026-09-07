@echo off
setlocal EnableExtensions DisableDelayedExpansion

pushd "%~dp0" >nul || (
  echo [ERROR] Cannot enter the project root directory.
  exit /b 1
)

set "DESKTOP_DIR=%CD%\apps\desktop"
set "PRODUCTION_ENV=%DESKTOP_DIR%\.env.production"
set "OUTPUT_DIR=%DESKTOP_DIR%\src-tauri\target\release\bundle\nsis"

echo [INFO] Yingjiang Windows production installer build

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

rem Load every non-commented key from apps\desktop\.env.production.
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%PRODUCTION_ENV%") do (
  if not "%%A"=="" set "%%A=%%B"
)

set "NODE_ENV=production"
if not defined VITE_PLATFORM_API_URL (
  echo [ERROR] VITE_PLATFORM_API_URL is missing from .env.production.
  goto :failed
)
if not defined AIVS_UPDATER_PUBLIC_KEY (
  echo [ERROR] AIVS_UPDATER_PUBLIC_KEY is required for signed online updates.
  goto :failed
)
if not defined TAURI_SIGNING_PRIVATE_KEY (
  echo [ERROR] TAURI_SIGNING_PRIVATE_KEY must be supplied by the secure build environment.
  goto :failed
)
if not defined TAURI_SIGNING_PRIVATE_KEY_PASSWORD (
  echo [ERROR] TAURI_SIGNING_PRIVATE_KEY_PASSWORD must be supplied by the secure build environment.
  goto :failed
)

powershell.exe -NoProfile -NonInteractive -Command "$uri = $null; $value = $env:VITE_PLATFORM_API_URL; if (-not [Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https' -or $uri.IsLoopback) { exit 1 }"
if errorlevel 1 (
  echo [ERROR] VITE_PLATFORM_API_URL must be a non-local HTTPS production URL.
  goto :failed
)

powershell.exe -NoProfile -NonInteractive -Command "$tauri = Get-Content -Raw '%DESKTOP_DIR%\src-tauri\tauri.conf.json' | ConvertFrom-Json; $cargo = Get-Content -Raw '%DESKTOP_DIR%\src-tauri\Cargo.toml'; $package = Get-Content -Raw '%DESKTOP_DIR%\package.json' | ConvertFrom-Json; if ($cargo -notmatch '(?m)^version\s*=\s*\"([^\"]+)\"') { exit 1 }; if ($tauri.version -ne $package.version -or $tauri.version -ne $Matches[1]) { Write-Error ('Desktop versions differ: tauri=' + $tauri.version + ', package=' + $package.version + ', cargo=' + $Matches[1]); exit 1 }"
if errorlevel 1 (
  echo [ERROR] package.json, Cargo.toml and tauri.conf.json must use the same version.
  goto :failed
)

echo [OK] Production environment, signing keys, and version numbers validated.
if /i "%~1"=="--check" goto :check_complete

echo [INFO] Building the NSIS installer. This can take several minutes...
call npm run build:installers:windows
if errorlevel 1 goto :failed

echo.
echo [SUCCESS] Windows installer build completed.
echo [OUTPUT] %OUTPUT_DIR%
echo [INFO] Publish the generated .nsis.zip file and its .sig companion in Version Management.
goto :success

:check_complete
echo [SUCCESS] Build prerequisites and production configuration are ready.
goto :success_no_pause

:failed
set "BUILD_EXIT_CODE=%ERRORLEVEL%"
if "%BUILD_EXIT_CODE%"=="0" set "BUILD_EXIT_CODE=1"
echo.
echo [FAILED] Installer build did not complete.
if /i not "%~1"=="--no-pause" pause
popd >nul
endlocal & exit /b %BUILD_EXIT_CODE%

:success
if /i not "%~1"=="--no-pause" pause

:success_no_pause
popd >nul
endlocal & exit /b 0
