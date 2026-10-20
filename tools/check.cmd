@echo off
rem Project gate: typecheck and tests must pass.
setlocal
cd /d "%~dp0.."
echo check: typecheck
call npm run --silent typecheck || exit /b 1
echo check: tests
call npm test --silent || exit /b 1
echo check: ok
