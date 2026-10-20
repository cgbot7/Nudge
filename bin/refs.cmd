@echo off
rem Thin launcher so `refs` works from PATH before `refs install` exists.
node "%~dp0..\packages\cli\src\main.ts" %*
