@echo off
setlocal

cd /d "%~dp0"

set "AIVS_PLATFORM_API_URL=https://ai-studio.yuntianxing.net/api/v1"
set "VITE_PLATFORM_API_URL=%AIVS_PLATFORM_API_URL%"

echo AI Video Studio - Remote Debug Mode
echo API: %VITE_PLATFORM_API_URL%
echo.

if /I "%~1"=="--show-config" exit /b 0

where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm was not found. Install Node.js or add npm to PATH.
  pause
  exit /b 1
)

call npm run tauri:dev
set "AIVS_EXIT_CODE=%ERRORLEVEL%"

if not "%AIVS_EXIT_CODE%"=="0" (
  echo.
  echo Remote debug exited with code %AIVS_EXIT_CODE%.
  pause
)

exit /b %AIVS_EXIT_CODE%
