@echo off
setlocal

cd /d "%~dp0"
title AI Video Studio - Debug Mode

where npm.cmd >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js/npm was not found. Install Node.js 20 or later first.
    pause
    exit /b 1
)

where cargo.exe >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Rust/Cargo was not found. Install the Rust toolchain first.
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo [ERROR] Project dependencies are not installed.
    echo Run: npm.cmd install
    pause
    exit /b 1
)

echo Starting AI Video Studio in debug mode...
echo Project: %CD%
echo Local API: http://localhost:3101/api/v1
echo Make sure the API is running in another terminal: npm.cmd run dev:server
echo.

call npm.cmd run tauri:dev
set "DEBUG_EXIT_CODE=%ERRORLEVEL%"

if not "%DEBUG_EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] Debug mode exited with code %DEBUG_EXIT_CODE%.
    pause
)

endlocal & exit /b %DEBUG_EXIT_CODE%
