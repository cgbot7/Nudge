@echo off
rem Thin launcher so `nudge` works from PATH before `nudge install` exists.
node "%~dp0..\packages\cli\src\main.ts" %*
