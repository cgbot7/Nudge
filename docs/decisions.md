# Design decisions

The choices an interviewer is most likely to ask about, with the reason for each and what it costs. The full spec is in [SPEC.md](../SPEC.md); how the parts fit together is in [architecture.md](architecture.md).

> **Note (2026-10-28):** the hook and popup timings quoted in decisions 6 and 9 were measured by hand during development; the repo holds no script or raw data for them. The test count in decision 12 was rechecked on 2026-10-28: 133 of 133 passed, with the test step taking 24.4 s.

## 1. TypeScript that Node runs directly, no build step

**Decision.** Node 24 runs the `.ts` sources as they are (type stripping). `tsconfig.json` sets `noEmit`, `erasableSyntaxOnly` and `allowImportingTsExtensions`, so TypeScript 7 only typechecks. The popup frontend uses the same idea: `apps/popup/build.ts` calls Node's `stripTypeScriptTypes` and copies the runtime-only Vue build, with no bundler.

**Why.** There is nothing to rebuild before the CLI, the MCP server, the scheduled task or the agent hooks run, and stack traces point at the real source lines. Leaving out a bundler removed a whole dependency tree and a second TypeScript version the Vue tooling would have needed.

**Cost.** Only erasable syntax is allowed (no enums, namespaces or parameter properties), imports must spell out `.ts`, and Node 24 or newer is required. `stripTypeScriptTypes` is still marked experimental, so the build passes `--disable-warning=ExperimentalWarning`. Vue components are written as render functions instead of single-file templates, which reads less naturally.

## 2. The library is a Git repo; everything else is derived

**Decision.** Sheets live in a library folder that is its own Git repo, with `manifest.json` as the record of each sheet (`manifest.ts`). Import moves the original in and commits (`import.ts`, `git.ts`). The index, caches and usage log under `%LOCALAPPDATA%\nudge` can be deleted; `nudge index --rebuild` recreates them (`indexer.ts`). OCR text is the one slow result kept in the library (`ocr/<sha256>.txt`), so a rebuild never needs the vision model.

**Why.** One copy of each sheet means nothing drifts, history and sync come free from Git, and a corrupt index is never a data loss.

**Cost.** Every change is a commit, and binary files grow history with each version, so imports over 20 MB get a warning. Moving a file out of another repo shows as a deletion there, so import asks first.

## 3. SQLite FTS5 plus brute-force cosine, no vector database

**Decision.** `db.ts` keeps sections in SQLite (WAL mode) with an FTS5 table weighted toward titles and tags. Embeddings are normalized float32 blobs keyed by the hash of the text and the model name. `search.ts` scores every stored vector in JavaScript, then merges the keyword and vector rankings with reciprocal rank fusion, boosts the current project's tags and demotes stale sheets.

**Why.** At personal scale (a few thousand sections) a linear scan takes milliseconds, and one SQLite file is simpler to rebuild, back up and test than a separate service. Keying vectors by text hash means an edit re-embeds only the sections that changed, and a model change is detected by name.

**Cost.** Search time grows linearly with the library. That is fine for one person's notes and would need an approximate index at a much larger size.

## 4. Local AI only, and every feature works without it

**Decision.** Embeddings, tag proposals, suggestions and OCR go to Ollama on the local machine (`ollama.ts`, `ai.ts`). A health check with a 1.5 s timeout decides the path: search falls back to keyword with a visible notice, imports still happen but are queued as `pending`, and images wait in the inbox until OCR is possible.

**Why.** Cheat sheets can hold private details, so nothing leaves the machine. Ollama is a tray app that is often not running, so the tool has to stay useful without it.

**Cost.** Hybrid search, tagging and OCR depend on a model being pulled and warm. The local chat model is slower and less reliable than a hosted one, which is why its output is checked so strictly (next decision).

## 5. Model output is validated, never trusted

**Decision.** Every model reply must match a strict zod schema (`TagReplySchema` in `llm.ts`, `SuggestReplySchema` in `suggest.ts`, `DraftReplySchema` in `drafts.ts`), also sent to Ollama as the JSON schema for the reply. A bad reply gets one retry at temperature 0, then the tool gives up and asks the user. Documents and project files go into the prompt wrapped as untrusted data, and nothing a model returns is run.

**Why.** A README or a sheet can contain text that looks like instructions, and small local models drift from the requested format.

**Cost.** Sometimes there is simply no proposal and the user types the tags. Suggestions that break a rule (no detected project tag, or a repeat of an existing sheet) are dropped and reported rather than repaired.

## 6. No background service

**Decision.** The prompt hook (`shell/nudge-hook.ps1`) reads `hook-cache.json` and records the project you entered in `last-project.json`. `nudge index` writes the cache with one project per line (`hookcache.ts` `serializeHookCache`), so the hook finds its project with a plain string search instead of parsing JSON. Task Scheduler runs `nudge index` at logon and every 30 minutes. The popup is the only resident process, because a global hotkey needs one, and nothing else depends on it.

**Why.** A prompt hook runs before every prompt, so it must be fast and must never break the shell. Avoiding a daemon means nothing to keep alive, update or debug.

**Cost.** The cache can be up to 30 minutes behind; `nudge scan .` refreshes one project at once, and an unknown project under a root triggers a hidden background scan. In a sandbox run the hook took a median 7.5 ms over 10 runs, but the first run in a fresh PowerShell session took 102 ms while the session warmed up.

## 7. A secret scan on every import

**Decision.** `secrets.ts` checks extracted text, OCR text included, for provider key formats, private key blocks, connection strings with passwords and high-entropy values assigned to names like `token`. A finding blocks the import; inbox files go to `_blocked` with a reason file naming the line and rule. A false positive can be allowlisted with `nudge allow`, which stores a fingerprint of the matched text.

**Why.** Imported files get committed to Git and sent to a model, so a leaked key would spread. Cheat sheets are full of example keys, so placeholders such as `sk-xxxx` and `<API_KEY>` are ignored.

**Cost.** Pattern matching has false positives and false negatives. The fingerprint means an allowlist entry only covers that exact text, so editing the sheet to add a new secret is caught again.

## 8. One writer at a time

**Decision.** Every write to the library or the derived data goes through `lock.ts` (`acquireLock` on `nudge.lock`), and caches are written to a temp file and renamed (`util.ts` `writeFileAtomic`). A scheduled index that finds the lock taken exits quietly, the CLI waits up to 10 s, and the popup waits 2 s and then shows "busy".

**Why.** The scheduled task, the CLI, the MCP server and the popup can all run at the same time. Readers such as the prompt hook must never see a half-written file.

**Cost.** Two writes never overlap, so a long index run makes a popup action wait or fail with "busy" and ask you to try again. A lock left behind by a crashed process is taken over once its process is gone.

## 9. Popup: Tauri for the window, Node for the logic

**Decision.** `apps/popup` is a Tauri v2 tray app whose Rust code (`src-tauri/src/main.rs`) owns only the tray, the global shortcut and the window, and keeps a Node sidecar (`packages/sidecar`) alive. They exchange JSON lines over stdio, and the sidecar reuses `@nudge/core` for search, preview and the learned, verify and approve actions. The window is created hidden and already rendered at startup. Keystrokes get a keyword pass at once and a hybrid pass after a 250 ms pause, with sequence numbers so older replies are dropped (`apps/popup/src/logic.ts` `SearchScheduler`).

**Why.** No logic is written twice in Rust. Keeping the window pre-rendered met the 300 ms budget by a wide margin: 8 ms from hotkey to visible, measured from outside the app. The sidecar opens `index.db` per request, so `nudge index --rebuild` can replace the file while the popup runs.

**Cost.** Building the popup needs a Rust toolchain and the MSVC build tools, and Windows Smart App Control blocks the unsigned programs a Rust build produces. The popup holds one Node process for its whole lifetime.

## 10. Sheet content is untrusted in every surface

**Decision.** Agents get sheet text inside a `<reference_data>` wrapper with a note that it is data, not instructions (`agent.ts` `wrapReferenceData`). The popup renders Markdown in the sidecar, not in the webview (`sidecar/src/markdown.ts`): raw HTML is escaped, only http, https and mailto become links and they open in the browser only after a click, and images load only from inside the library as data URIs. A content security policy without inline scripts or eval and a navigation guard back this up.

**Why.** Sheets come from many places, including web pages saved as Markdown and model drafts.

**Cost.** Some Markdown is shown less richly: inline HTML appears as text and remote images as placeholders. Link reference definitions are switched off until the markdown-it release that fixes a slow-rendering advisory is old enough to adopt.

## 11. Installer as a plan, then an apply

**Decision.** `nudge install` first builds a plan (`install.ts` `planInstall`, `agents.ts` `planAgents`, `install.ts` `planPopupLogon`) and prints every change: the profile block, the scheduled task, the PATH entry, the Claude Code hook and MCP server, the OpenCode config and plugin, and the Run value that starts the popup at logon. `--dry-run` stops there; otherwise it asks before applying. Each step is idempotent, writes a backup first, and refuses to rewrite files it cannot parse, such as JSON with comments. All machine access goes through a `SystemOps` interface.

**Why.** It edits files and settings that belong to other tools, so you should see exactly what changes, and running it twice must not duplicate anything. The `SystemOps` seam lets tests plan and apply against a fake machine.

**Cost.** More code than a setup script would need, and a file it refuses to rewrite has to be edited by hand from the entry it prints. Claude Code's MCP entry is registered through `claude mcp add-json` rather than edited directly, so that step needs `claude.exe` on PATH.

## 12. Tests in sandboxes, with fakes for everything outside

**Decision.** Tests use `node:test`. `packages/core/test/helpers.ts` gives each test its own APPDATA, LOCALAPPDATA, library, documents folder, home folder, task name, registry key and popup path, all through environment overrides the code reads on every call. A fake Ollama HTTP server (`fakeollama.ts`) answers with canned embeddings and replies, any request to port 11434 throws, and a fake `SystemOps` records what install would do. CLI, MCP and sidecar tests start the real processes and talk to them.

**Why.** The tool's job is to change a real machine (profiles, the scheduler, agent configs, the registry), so the tests must never touch the developer's own.

**Cost.** Starting real processes makes the suite take about 25 s for 133 tests. The real Task Scheduler and `claude.exe` are only exercised by hand; the real registry calls are tested against a throwaway key, never the Run key.

## What it deliberately does not do

Following [SPEC.md](../SPEC.md), there are no web sources or bookmarks (export to a file first), no editing of sheets inside the tool, no notes typed into the popup, no agent writing sheets, no shells other than PowerShell, and no build for macOS or Linux. Each of these would add a surface to secure or a second place to edit, for a personal tool that already has a normal editor and a library folder.
