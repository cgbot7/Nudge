# nudge: personal cheat sheet index

> **Status (2026-10-28):** all five milestones below are built. This file is the plan they were built from and is kept as written. Where the code differs: the default chat and vision model is `mistral-small3.2:24b`; the MCP server uses `@modelcontextprotocol/server` 2.3.1 instead of `@modelcontextprotocol/sdk`; the library also holds `gap-ignores.json` and `ocr\<sha256>.txt`, and `%LOCALAPPDATA%\nudge` also holds `pending-allow.json` and `suggestions.json`; `nudge install` also puts `bin` on the user PATH and starts the popup at logon. For the current behavior see [README.md](README.md) and [docs/architecture.md](docs/architecture.md).

Spec for a local tool that collects every cheat sheet and reference note into one library and puts the right ones in front of you automatically, in the terminal, in your AI agent, and in a hotkey popup.

## Goal

Stop writing reference sheets that never get used. The tool should:

1. Gather all sheets (any format) into one library that is the single source of truth.
2. Know what kind of project you are in and surface the sheets that fit, without you asking.
3. Let you type a project type or question and get matching sheets, gaps, and suggestions.
4. Track which sheets you actually use, and keep nudging you about the ones you don't.

Success is behavioral: after a month of use, most relevant sheets have been opened or fetched by an agent at least once, and new sheets land in the library instead of in random folders.

## Scope

**Library and import**
- One library folder, a private Git repo, holding every sheet. Import **moves** the original in; a manifest records its original path and SHA256, so no second copy exists to drift.
- Formats: Markdown, TXT, DOCX, PDF (text layer), PDF (scanned) and images (PNG, JPG) via local OCR.
- Two ways in: `nudge add <file>` and an inbox folder processed on each index run.
- Secret scan on every import. Likely secrets block the import until redacted or allowlisted.
- Large documents split by heading (Markdown and DOCX) so each section is its own searchable entry.
- Local LLM proposes a title and tags on import; you confirm or edit. Inbox items wait in a review queue.

**Matching**
- Project type detected from file signatures, using rules in an editable `rules.json`.
- Hybrid search: keyword (SQLite FTS5) plus embeddings from Ollama, fused, boosted by current project tags.
- "Type a project type" mode: `nudge for "node ollama docker"` returns sheets grouped by tag, plus gaps.

**Surfacing**
- Terminal: a PowerShell prompt hook prints one line every time you enter a project under a registered root.
- Agent: an MCP server (search, get, for-project) plus a Claude Code SessionStart hook that injects a compact index of matched sheets. The agent fetches full sheets on demand.
- Popup: a Tauri tray app with a global hotkey and a search box.

**Suggestions**
- Surface matched sheets.
- Flag gaps: a detected tag with zero sheets of any status.
- Remind unused sheets: relevant sheets never used, or not used in 30 days, and not marked learned.
- LLM recommendations on demand (`nudge suggest`), shown as a list; any one can be saved as a **draft** sheet marked unverified.

**Maintenance**
- Each sheet has a last-verified date. After 180 days (configurable) it is marked stale and shown with a warning.
- Usage counts as: opened via the tool (CLI or popup), fetched by an agent through MCP, or marked learned (which retires reminders).

## Out of scope (v1)

- URLs, bookmarks, Claude artifact links, or any web source. Export to a file first, then import.
- Agents writing new sheets through MCP, and quick notes typed in the popup.
- Counting a copied snippet as usage.
- LLM-judged gaps and "thin coverage" gaps (only drafts or only stale sheets).
- Verifying LLM suggestions against the web.
- Editing sheets inside the tool. You edit files in the library with your normal editor.
- Shells other than PowerShell (Bash, WSL, cmd). Windows only; no macOS or Linux build.
- Multi-device sync beyond `git push` to the private repo, sharing with other people, Git LFS.
- Any always-on background service. The terminal hook and MCP server never depend on one.

## Stack and constraints

- **Platform:** Windows 11. PowerShell 7 is the target shell; Windows PowerShell 5.1 is best effort.
- **Core:** Node.js LTS and TypeScript, as a small monorepo (core library, CLI, MCP server). Validation with zod.
- **Index:** SQLite (`better-sqlite3`) in WAL mode, FTS5 for keyword search, embedding vectors stored as blobs and searched by brute-force cosine in JS. At personal scale (a few thousand sections) that is milliseconds; no vector database needed.
- **Extraction:** `mammoth` for DOCX, `pdfjs-dist` for PDF text and for rendering pages to images when a page has no text.
- **Local AI (Ollama):** three models set in config:
  - embedding model (use a multilingual one such as `bge-m3` if any sheets are in Spanish)
  - chat model for tagging and suggestions (Qwen, direct or through your relay; any OpenAI-compatible endpoint)
  - vision model for OCR
- **Agent:** `@modelcontextprotocol/sdk`, stdio transport.
- **Popup:** Tauri v2 tray app, Vue and TypeScript frontend, global shortcut plugin.
- **Runtime rule (no daemon):** all slow work (extraction, OCR, LLM, embeddings, project scans) happens in `nudge index`, run on demand and by Windows Task Scheduler (at logon and every 30 minutes). The terminal hook only reads a precomputed JSON cache. The popup is resident only because a global hotkey requires a running process; it may keep a Node sidecar alive while it runs, but nothing else depends on it.
- **Performance budgets:** hook adds under 50 ms to the prompt; popup visible under 300 ms after the hotkey; keyword results under 100 ms; hybrid results under 1 s with Ollama warm.
- **Privacy:** fully local. No network calls except to the configured Ollama host and an explicit `git push`.
- **Writing style:** CLI output and generated drafts use plain punctuation (no em dashes).

## Files and interfaces

### Tool repository

```
nudge/
  packages/core/src/
    config.ts         load and validate config.json
    manifest.ts       read, write, and diff manifest.json
    import.ts         add pipeline: hash, extract, scan, propose, move, commit
    extract/          markdown.ts, docx.ts, pdf.ts, image.ts (OCR)
    secrets.ts        detectors, placeholder filter, allowlist
    chunk.ts          split by heading into sections
    db.ts             SQLite schema, FTS5, vectors
    embed.ts          Ollama embeddings, model-change detection
    search.ts         keyword + vector fusion (reciprocal rank fusion), tag boost, stale demote
    rules.ts          signature rule engine
    detect.ts         project root resolution and tag detection
    usage.ts          usage.jsonl events, unused and reminder logic
    hookcache.ts      writes hook-cache.json
    llm.ts            tag proposal and suggestions, schema-validated JSON
    lock.ts           single-writer lock
  packages/cli/src/main.ts
  packages/mcp/src/server.ts
  apps/popup/         Tauri v2 + Vue
  shell/nudge-hook.ps1 PowerShell prompt hook (no Node at runtime)
```

### Data locations

```
%USERPROFILE%\nudge-library\     Git repo, the source of truth
  sheets\                       imported files, named <id>-<slug>.<ext>
  drafts\                       LLM drafts (Markdown)
  manifest.json                 one entry per sheet
  rules.json                    signature rules (you extend this)
  tags.json                     tag vocabulary and aliases
  inbox\                        drop folder, listed in .gitignore
    _blocked\  _duplicates\     items that failed import, with a reason file
%LOCALAPPDATA%\nudge\            derived and rebuildable
  index.db  extract-cache\<sha256>.txt  hook-cache.json
  usage.jsonl  last-project.json  nudge.lock  logs\
%APPDATA%\nudge\config.json      machine-specific settings
```

Deleting everything under `%LOCALAPPDATA%\nudge\` must lose nothing except usage history; `nudge index --rebuild` recreates it from the library.

### config.json

```json
{
  "library": "C:/Users/<you>/nudge-library",
  "roots": ["D:/Projects", "C:/Users/<you>/source"],
  "ollama": { "host": "http://localhost:11434", "embedModel": "bge-m3", "chatModel": "qwen", "visionModel": "<vision model>" },
  "staleAfterDays": 180,
  "unusedAfterDays": 30,
  "hotkey": "Ctrl+Alt+Space",
  "ocrMaxPages": 50
}
```

### manifest.json entry

```json
{
  "id": "s_0042",
  "title": "Docker basics",
  "file": "sheets/s_0042-docker-basics.md",
  "originalPath": "D:/Projects/pokepurch/docker-notes.md",
  "sha256": "…",
  "format": "md",
  "tags": ["docker", "docker-compose"],
  "status": "verified",
  "source": "imported",
  "learned": false,
  "lastVerified": "2026-10-20",
  "updatedAt": "2026-10-20",
  "secretAllowlist": []
}
```

`status` is one of `pending` (tags not yet confirmed), `verified`, or `draft`. `source` is `imported` or `llm` (drafts also record the model and date).

### rules.json entry

```json
[
  { "tag": "node", "files": ["package.json"] },
  { "tag": "playwright", "packageDeps": ["playwright", "@playwright/test"] },
  { "tag": "godot", "files": ["project.godot"] },
  { "tag": "docker", "files": ["Dockerfile", "docker-compose.yml", "compose.yaml"] },
  { "tag": "autohotkey", "files": ["*.ahk"] },
  { "tag": "comfyui", "files": ["*.json"], "contentRegex": "\"class_type\"" }
]
```

Supported keys: `files` (globs), `packageDeps` (package.json dependencies), `pyDeps` (requirements.txt or pyproject), `contentRegex` (checked against the first 64 KB of matched files). Scans skip `node_modules`, `.git`, `venv`, `.venv`, `dist`, `build`, `models`, and stop at depth 3 or 5,000 files.

### CLI

```
nudge add <file> [--tags a,b] [--yes]   import one file
nudge index [--rebuild]                 inbox, library changes, embeddings, project scans, hook cache
nudge review                            confirm tags for pending items
nudge search <query> [--tags a,b] [--json]
nudge for <path | "tag tag">            sheets by tag, gaps, unused reminders
nudge open <id> [--section <n>]         open (Markdown in terminal or editor, others in default app); logs usage
nudge suggest [path]                    LLM recommendations; pick one to save as draft
nudge approve <id>                      draft or pending to verified; sets lastVerified
nudge verify <id>                       bump lastVerified
nudge learned <id> [--undo]
nudge allow <file> --finding <n>        allowlist a secret-scan false positive
nudge ignore-gap <tag> [--project]
nudge scan [path]                       re-detect one project, rewrite its cache entry
nudge context --cwd <dir>               compact index for agent session start
nudge doctor                            check Ollama, models, manifest vs files, lock, schedule
nudge install                           add PowerShell hook, Task Scheduler job, MCP registration
```

### Terminal line

One line each time you enter a different project (moving between subfolders of the same project prints nothing):

```
nudge [node, docker, playwright] 4 sheets (1 stale) | gap: playwright | try: "Docker volumes" | nudge for .
```

`try:` rotates through relevant unused sheets, one per entry. If the folder is under a root but not in the cache, the hook prints `nudge: new project, scanning` and starts `nudge scan` hidden in the background.

### MCP tools

```
nudge_search(query: string, tags?: string[], limit?: number = 5)
  -> [{ id, title, section, tags, status, stale, snippet }]
nudge_get(id: string, section?: number)
  -> { id, title, section, text, status, stale, lastVerified }
nudge_for_project(path: string)
  -> { tags, sheets: [...], gaps: [...] }
```

Results include `status` and `stale` so the agent can say when it is relying on an old or draft sheet. Text is wrapped as reference data, not instructions. Every `nudge_get` writes an `agent_fetch` usage event.

**Claude Code:** a SessionStart hook runs `nudge context --cwd <dir>`; its output (at most 10 entries, about 300 tokens: id, title, tags, stale flag, and one line telling the agent to call `nudge_get`) is added to session context. Drafts are excluded from this index but remain findable through `nudge_search`, flagged as drafts.
**OpenCode:** MCP server registered in its config. How to inject the start-of-session index depends on OpenCode's current plugin or instructions mechanism; confirm against its docs during milestone 4.

### Popup

Search box with results as you type (keyword first, re-ranked by hybrid search when typing pauses). Each result shows title, section, tags, and draft or stale badges. Enter opens a preview (rendered Markdown, extracted text with the original image for OCR sources); a second Enter opens the file in its default app. Buttons: mark learned, mark verified. Searches are boosted by the project in `last-project.json`, written by the terminal hook.

## Edge cases

**Import and library**
- **Duplicate content:** same SHA256 already in the manifest. CLI reports the existing id and changes nothing; inbox moves the file to `_duplicates`.
- **File tracked in another Git repo:** moving it creates a deletion in that repo. Import detects this (`git ls-files`) and asks for confirmation, or requires `--yes`.
- **Moves across drives:** copy, verify hash, then delete the original. If deletion fails, keep both and report; never leave the library entry unverified.
- **Locked files:** Word holds a lock on open DOCX files. Import fails gracefully and leaves the original in place. Office lock files (`~$*.docx`) are ignored everywhere.
- **Edited in the library:** next index sees a new hash, re-extracts, re-embeds, updates `sha256` and `updatedAt`. Editing does not reset `lastVerified` and does not approve a draft.
- **Renamed or deleted outside the tool:** index matches unknown files to missing entries by hash (rename). Unmatched entries are reported by `nudge doctor`, never silently removed.
- **Large binaries:** warn on files over 20 MB, since Git history grows with every version.
- **Windows paths:** normalize to forward slashes and a lowercase drive letter before comparing; support long paths and accented filenames.

**Secrets**
- Detectors: provider key prefixes (AWS, GitHub, OpenAI, Anthropic, Slack, Stripe), private key blocks, connection strings with passwords, and high-entropy values assigned to names like `key`, `token`, `secret`, `password`.
- Placeholders such as `sk-xxxx`, `your-key-here`, `<API_KEY>` are ignored, since cheat sheets are full of them.
- OCR text is scanned too. A blocked inbox file goes to `_blocked` with a reason file listing line and rule, never into the library or the index.
- Allowlist entries store a fingerprint of the matched text, so editing the sheet elsewhere does not silently allow a new secret.

**Extraction and OCR**
- PDF pages with no text layer are rendered and OCR'd, up to `ocrMaxPages`; beyond that, ask or import the first pages only.
- OCR can mangle code and commands. OCR'd entries are labeled as such and the preview always shows the original image beside the text.
- Heading split: sections with no heading become "Intro"; a heading with only a few words of body merges into the next section.

**LLM and Ollama**
- **Ollama down:** hook and MCP unaffected; search falls back to keyword with a notice; imports still move and keyword-index, but tagging and OCR are queued as `pending`.
- **Embedding model changed:** vectors store their model name; a mismatch triggers a full re-embed on the next index.
- **Tag drift** (`ollama`, `Ollama`, `local-llm`): tags are lowercase kebab case, `tags.json` holds aliases, and the LLM must prefer existing tags and mark new ones for your confirmation.
- **Prompt injection:** `nudge suggest` reads READMEs and manifests, which are untrusted. Output must match a JSON schema; anything else is discarded. The tool never runs anything a model returns.
- **Bad JSON from the model:** retry once at temperature 0, then fall back to no proposal and ask you directly.

**Detection and hook**
- **Project root:** the nearest ancestor (inside a registered root) with `.git` or a signature file, otherwise the first-level folder under the root. Nested repos inside a project count as their own project.
- **Unknown project types:** no rule matches, so the line says `nudge: no tags (add a rule to rules.json)`. Unknown types are fixed by adding rules, not by guessing.
- **Project changes** (you add a Dockerfile): picked up at the next scheduled index or immediately with `nudge scan .`.
- **Hook cache missing or corrupt:** the hook prints nothing and never throws; `nudge doctor` reports it.
- **Gap noise:** a tag you never intend to document can be silenced with `nudge ignore-gap`.

**Concurrency**
- One writer at a time via `nudge.lock`. A scheduled index that finds the lock exits quietly; a CLI command waits up to 10 seconds, then reports. The hook only reads, and the cache is written atomically (temp file then rename).

## Milestones

1. **Library and keyword search.** Config, manifest, `nudge add` for MD, TXT, DOCX and text PDFs, secret scan with allowlist, move with hash verify, auto-commit, heading split, SQLite FTS5, `nudge search`, `nudge open`, `nudge doctor`.
2. **Detection and terminal hook.** `rules.json` engine, registered roots, project root resolution, hook cache, PowerShell prompt hook, gaps, usage log and unused reminders, stale marking, `nudge for`, `nudge scan`, Task Scheduler via `nudge install`.
3. **Local AI layer.** Embeddings and hybrid search, LLM tag proposal with confirm, inbox and `nudge review`, OCR for images and scanned PDFs, Ollama-down fallbacks, model-change re-embed.
4. **Agent integration.** MCP server, `nudge context`, Claude Code SessionStart hook, OpenCode registration, `agent_fetch` usage events, `nudge suggest` with draft saving and `nudge approve`.
5. **Hotkey popup.** Tauri tray app, global shortcut, live search, preview, mark learned and verified, project boost from `last-project.json`.

## Done means

Run this script on a clean machine profile with Ollama installed. Every step must pass.

1. `nudge install`, then register a test root containing a project with `package.json` (depends on `playwright`) and a `Dockerfile`. Library and Task Scheduler job exist; `nudge doctor` is all green.
2. Drop three files in the inbox: `docker-notes.md` (several headings), `ollama-pull.png` (screenshot of a terminal command), and `git-tips.docx` containing a real-looking `ghp_` token. Run `nudge index`.
   - The MD and PNG files leave the inbox, appear in `manifest.json` as `pending`, and each has a Git commit.
   - The DOCX lands in `_blocked` with a reason file naming the line and rule, and is not in the index.
3. `nudge review` accepts proposed tags. Redact the DOCX, drop it back in, run `nudge index`; it imports.
4. In a new PowerShell window, `cd` into the test project. Within 50 ms the line shows tags `node, docker, playwright`, the Docker sheet, `gap: playwright`, and a `try:` suggestion. `cd` into a subfolder prints nothing.
5. Stop Ollama. `nudge search "remove stopped containers"` returns the matching Docker section with a "keyword only" notice. Start Ollama. `nudge search "download a model"` returns the OCR'd screenshot.
6. Start Claude Code in the project. The session context lists the matched sheets (no drafts). Ask how to prune Docker images using your notes; the agent calls `nudge_get`, and `usage.jsonl` gains an `agent_fetch` event. Re-enter the project: that sheet is no longer offered in `try:`.
7. `nudge suggest .` returns schema-valid recommendations. Save one as a draft. It shows as `[draft]` in `nudge search`, is absent from `nudge context`, and becomes normal after `nudge approve`.
8. Press the hotkey. The popup appears in under 300 ms; search "docker", preview a section, mark it learned. It never appears in `try:` again.
9. Set one sheet's `lastVerified` to 200 days ago and run `nudge index`. It shows as stale in the hook line, search, popup and MCP results. `nudge verify` clears it.
10. Delete `%LOCALAPPDATA%\nudge\index.db` and run `nudge index --rebuild`. Steps 4, 5 and 8 give the same results, proving the library alone is the source of truth.
