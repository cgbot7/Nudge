@echo off
rem Project gate: typecheck, the popup's frontend build and cargo check, and tests must pass.
setlocal
cd /d "%~dp0.."
echo check: typecheck
call npm run --silent typecheck || exit /b 1
echo check: popup (frontend build, cargo check)
node --disable-warning=ExperimentalWarning apps\popup\build.ts --check || exit /b 1
echo check: tests
call npm test --silent || exit /b 1
echo check: ok
