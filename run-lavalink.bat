@echo off
title Lavalink Server - ANTIMUSIC
cd /d "%~dp0lavalink"
echo ===================================================
echo             Starting Lavalink Server...
echo ===================================================

if not exist "%~dp0lavalink\Lavalink.jar" (
    echo [INFO] Lavalink.jar tidak ditemukan di folder lavalink.
    echo [INFO] Mengunduh Lavalink.jar v4.2.2 dari GitHub release...
    curl.exe -Lo "%~dp0lavalink\Lavalink.jar" "https://github.com/lavalink-devs/Lavalink/releases/download/4.2.2/Lavalink.jar"
    if errorlevel 1 (
        powershell -Command "Invoke-WebRequest -Uri 'https://github.com/lavalink-devs/Lavalink/releases/download/4.2.2/Lavalink.jar' -OutFile '%~dp0lavalink\Lavalink.jar'"
    )
)

if exist "%~dp0lavalink\jre\bin\java.exe" (
    "%~dp0lavalink\jre\bin\java.exe" -jar Lavalink.jar
) else (
    java -jar Lavalink.jar
)

if errorlevel 1 (
    echo.
    echo ===================================================
    echo [ERROR] Lavalink berhenti dengan error!
    echo ===================================================
)
pause
