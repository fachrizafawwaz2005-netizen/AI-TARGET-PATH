@echo off
setlocal enabledelayedexpansion
title TargetPath

echo ============================================
echo   TargetPath - Disease to Target to Compound
echo ============================================
echo.

where python >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    set PYCMD=python
    goto :foundpython
)

where py >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    set PYCMD=py
    goto :foundpython
)

echo Python was not found on this computer.
echo.
echo TargetPath needs Python only to serve the app's own files over
echo http://localhost (this avoids a browser restriction on file:// pages).
echo No Python packages are required - see requirements.txt.
echo.
echo Please install Python 3 from https://www.python.org/downloads/
echo During setup, make sure to check "Add python.exe to PATH".
echo Then run this file again.
echo.
pause
exit /b 1

:foundpython
echo Using: %PYCMD%
echo Checking requirements.txt (no external packages are required)...
echo.
echo Starting TargetPath at http://localhost:8000 ...
echo A browser tab should open automatically.
echo Keep this window open while you use TargetPath.
echo Press Ctrl+C here (then Y + Enter) to stop the server.
echo.

%PYCMD% "%~dp0server.py"

pause
