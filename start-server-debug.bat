@echo off
setlocal

cd /d "%~dp0"
title AI Video Studio - API Server Debug

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

echo Starting AI Video Studio API server in debug mode...
echo Project: %CD%
echo API: http://localhost:3101/api/v1
echo Health: http://localhost:3101/api/v1/health
echo.

echo Applying database migrations...
call npm.cmd run db:migrate
if errorlevel 1 (
    echo [ERROR] Database migration failed.
    pause
    exit /b 1
)

echo Synchronizing prompt, visual style, and creative type defaults...
call npm.cmd run db:seed-config
if errorlevel 1 (
    echo [ERROR] Default data synchronization failed.
    pause
    exit /b 1
)
echo.

call npm.cmd run dev:server
set "SERVER_EXIT_CODE=%ERRORLEVEL%"

if not "%SERVER_EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] API server exited with code %SERVER_EXIT_CODE%.
    pause
)

endlocal & exit /b %SERVER_EXIT_CODE%
