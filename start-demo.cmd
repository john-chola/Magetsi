@echo off
rem Double-click to start the DEMO copy of Magetsi (made-up data in magetsi-demo.db) and the ngrok public link.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-public.ps1" -Demo
pause
