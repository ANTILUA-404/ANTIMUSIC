@echo off
title ANTIMUSIC
echo ===================================================
echo           Starting ANTIMUSIC...
echo ===================================================
bun run dev
if errorlevel 1 (
    echo.
    echo Menjalankan dengan node...
    npm run dev
)
pause
