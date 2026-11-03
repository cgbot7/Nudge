# PowerShell tips

Things I keep looking up when scripting in PowerShell 7 on Windows 11.

## Profile

$PROFILE holds the path of the profile script that runs at every start.
Edit it with code $PROFILE; reload it in the current session with . $PROFILE.

## Execution policy

Get-ExecutionPolicy -List shows the policy for every scope.
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser lets local scripts run
while downloaded ones still need a signature.

## Environment variables

Read one with $env:PATH and set one for this session with $env:DEBUG = "1".
For a permanent user variable use [Environment]::SetEnvironmentVariable("DEBUG", "1", "User").

## Processes and ports

Get-Process node | Stop-Process kills every node process.
Get-NetTCPConnection -LocalPort 3000 shows which process holds a port;
its OwningProcess is the PID to stop.

## Objects in the pipeline

Get-ChildItem -Recurse -Filter *.log | Sort-Object Length -Descending | Select-Object -First 5 Name, Length
lists the five biggest log files. Where-Object filters, ForEach-Object runs a block per item.
