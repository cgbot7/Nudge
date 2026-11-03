# Python virtual environments

Keeping each Python project's packages separate with venv and pip.

## Create a venv

python -m venv .venv creates the environment in the project folder.
Use py -3.12 -m venv .venv to pick a specific Python version on Windows.

## Activate and deactivate

In PowerShell run .venv\Scripts\Activate.ps1; in Git Bash run source .venv/Scripts/activate.
The prompt shows (.venv) while it is active. Type deactivate to leave it.

## Requirements files

pip freeze > requirements.txt records the exact versions installed.
pip install -r requirements.txt installs them on another machine.

## Upgrade and inspect packages

pip list --outdated shows packages with newer releases, pip install -U requests upgrades one,
and pip show requests prints its version, location and dependencies.
