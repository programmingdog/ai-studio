@echo off
setlocal

cd /d "%~dp0"
title AI Video Studio - Admin Web Debug

where npm.cmd >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js/npm was not found. Install Node.js 20 or later first.
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo [ERROR] Project dependencies are not installed.
    echo Run: npm.cmd install
    pause
    exit /b 1
)

echo Starting AI Video Studio admin web in debug mode...
echo Project: %CD%
echo Admin: http://localhost:3200
echo API: http://localhost:3101/api/v1
echo Make sure the API is running in another terminal: start-server-debug.bat
echo.

call npm.cmd run dev:admin
set "ADMIN_EXIT_CODE=%ERRORLEVEL%"

if not "%ADMIN_EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] Admin web exited with code %ADMIN_EXIT_CODE%.
    pause
)

endlocal & exit /b %ADMIN_EXIT_CODE%
