# Windows Task Scheduler

Running scripts on a schedule or at logon without a background service.

## Create a task

schtasks /Create /TN "backup" /TR "pwsh -File C:\scripts\backup.ps1" /SC DAILY /ST 02:00
runs a script every night at two. Use /SC ONLOGON to run it when you sign in.

## Repeat every few minutes

/SC MINUTE /MO 30 repeats every thirty minutes. In the Task Scheduler window the same thing is
the trigger option "Repeat task every" with a duration of Indefinitely.

## Inspect and run

schtasks /Query /TN "backup" /V /FO LIST shows the last run time and last result.
schtasks /Run /TN "backup" starts it now, and schtasks /Delete /TN "backup" /F removes it.

## Hide the window

A task that starts pwsh flashes a console window. Run it with -WindowStyle Hidden,
or set the task to run whether the user is logged on or not.
