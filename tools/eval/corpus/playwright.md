# Playwright testing

End to end browser tests with Playwright Test for TypeScript projects.

## Setup

npm init playwright@latest scaffolds the config and an example test.
npx playwright install downloads the Chromium, Firefox and WebKit builds it drives.

## Run tests

npx playwright test runs everything headless. Add --headed to watch the browser,
--project=chromium for one browser, and -g "login" to run tests whose title matches.

## Record a test

npx playwright codegen http://localhost:3000 opens a browser and writes test code
for every click and keystroke you make.

## Locators

Prefer page.getByRole('button', { name: 'Save' }) and page.getByText over CSS selectors.
Locators wait for the element automatically, so explicit sleeps are rarely needed.

## Debug a failure

Run with --trace on, then npx playwright show-trace trace.zip to step through every action
with DOM snapshots, network calls and console output. --debug opens the inspector instead.
