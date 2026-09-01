@echo off
setlocal

cd /d "%~dp0"
title AI Video Studio - Platform Debug Launcher

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

if not exist "apps\server\.env" (
    echo [ERROR] Server environment file was not found: apps\server\.env
    echo Copy apps\server\.env.example to apps\server\.env and configure it first.
    pause
    exit /b 1
)

echo Starting AI Video Studio platform...
echo API:   http://localhost:3101/api/v1
echo Admin: http://localhost:3200
echo.

start "AI Video Studio - API Server" cmd.exe /d /c call "%~dp0start-server-debug.bat"
start "AI Video Studio - Admin Web" cmd.exe /d /c call "%~dp0start-admin-debug.bat"

echo API server and admin web were launched in separate windows.
echo You can close this launcher window.
timeout /t 3 /nobreak >nul

endlocal & exit /b 0
