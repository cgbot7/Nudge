# npm and Node.js

Package management and scripts for Node.js projects.

## Install dependencies

npm install adds what package.json lists and updates package-lock.json.
npm ci installs exactly what the lock file says and deletes node_modules first,
which is what CI servers should run.

## Scripts

npm run build runs the build entry of the scripts section in package.json.
npm test and npm start are shortcuts that need no run. List every script with npm run.

## Workspaces

A workspaces array in the root package.json makes one repo hold several packages.
npm install -w packages/core zod adds a dependency to one workspace,
and npm run test --workspaces runs a script in all of them.

## Security and updates

npm outdated lists packages with newer versions. npm audit reports known vulnerabilities
in the dependency tree, and npm audit fix applies the upgrades that stay within semver ranges.

## Run a tool once

npx create-vite@latest my-app runs a package's command without installing it globally.
