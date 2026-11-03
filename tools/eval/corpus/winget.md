# winget package manager

Installing and updating Windows applications from the terminal with winget.

## Find and install

winget search vscode finds packages and shows their ids. winget install --id Microsoft.VisualStudioCode -e
installs the exact id; add --scope user to install for the current user only.

## Upgrade everything

winget upgrade lists the applications that have newer versions, and winget upgrade --all installs every update.
Add --include-unknown for apps whose installed version winget cannot read.

## Export and import a machine

winget export -o apps.json writes the list of installed packages, and winget import -i apps.json
installs the same set on a new computer.

## Pin a version

winget pin add --id Git.Git keeps an application at its current version so upgrade --all skips it.
winget pin list shows the pins and winget pin remove takes one away.
