# Architecture

refs is a local Windows tool that keeps every cheat sheet in one Git-tracked library and puts the right ones in front of you: a line in the PowerShell prompt when you enter a project, an index and MCP tools for coding agents, and a hotkey popup with live search. It is a TypeScript monorepo that Node 24 runs directly (no build step), plus a small Tauri tray app. Slow work (extraction, OCR, embeddings, project scans) happens in `refs index`, run on demand and by Task Scheduler; the prompt hook, the MCP server and the CLI never depend on a running service.

## System context

What runs where, and everything it talks to. Ollama is optional: every path falls back to keyword search when it is down.

```mermaid
flowchart TB
  you(["You"])
  subgraph pc["Your Windows PC"]
    hook["Prompt hook<br/>shell/refs-hook.ps1"]
    sched["Task Scheduler<br/>task: refs index"]
    agents["Claude Code, OpenCode"]
    popup["Tray popup<br/>apps/popup, Tauri"]
    subgraph node["Node, shared core"]
      cli["refs CLI<br/>packages/cli"]
      mcp["MCP server<br/>packages/mcp"]
      sidecar["Popup sidecar<br/>packages/sidecar"]
    end
    data[("Derived data, rebuildable<br/>index.db, hook-cache.json, usage.jsonl")]
    lib[("Library, a Git repo<br/>sheets, manifest.json, rules.json")]
  end
  ollama["Ollama<br/>embeddings, tags, OCR"]

  you -->|cd into a project| hook
  you -->|commands| cli
  you -->|hotkey| popup
  sched -->|at logon and every 30 min| cli
  agents -->|"SessionStart: refs context"| cli
  agents -->|"MCP over stdio"| mcp
  popup <-->|"JSON lines over stdio"| sidecar
  hook -->|"reads the hook cache"| data
  node -->|"reads; writes under refs.lock"| lib
  node --> data
  node -.->|"HTTP, optional"| ollama
```

The prompt hook also records the project you entered in `last-project.json`, and starts a hidden `refs scan` only for a project folder the cache does not know yet.

## Components

The core library holds all logic; the four entry points are thin. The Rust side of the popup only owns the tray, the hotkey and the window, and relays JSON lines to the sidecar.

```mermaid
flowchart TB
  subgraph popup["apps/popup"]
    ui["src: app.ts, logic.ts, ipc.ts"]
    rs["src-tauri/src/main.rs<br/>tray, hotkey, window"]
  end
  subgraph entry["Entry points"]
    hook["shell/refs-hook.ps1"]
    cli["cli/src/main.ts"]
    side["sidecar/src<br/>main.ts, handlers.ts, markdown.ts"]
    mcp["mcp/src/server.ts"]
  end
  subgraph core["packages/core/src"]
    ops["install.ts, agents.ts, doctor.ts, lock.ts"]
    act["indexer.ts, actions.ts, review.ts"]
    agent["agent.ts, context.ts"]
    proj["rules.ts, detect.ts, hookcache.ts, usage.ts"]
    imp["import.ts, inbox.ts, secrets.ts"]
    idx["db.ts, embed.ts, search.ts"]
    lib["library.ts, manifest.ts, git.ts"]
    ext["extract/, chunk.ts"]
    ai["ollama.ts, llm.ts, suggest.ts, drafts.ts"]
  end
  ui --> rs
  rs --> side
  cli --> ops
  cli --> act
  side --> act
  side --> idx
  mcp --> agent
  agent --> idx
  act --> proj
  act --> imp
  imp --> lib
  imp --> ext
  idx --> ai
  hook -.->|"reads hook-cache.json"| proj
```

## A popup search, from hotkey to a learned sheet

The window is created hidden and already rendered at startup, so the hotkey only shows it (measured at 8 ms to visible, about 16 ms to the first painted frame). Every keystroke gets a keyword pass; a hybrid pass follows when typing pauses, and replies for older keystrokes are dropped. Messages between the UI and the sidecar pass through the Rust process, which the diagram leaves out.

```mermaid
sequenceDiagram
  actor U as You
  participant R as Popup, Rust
  participant W as Popup UI, Vue
  participant S as Sidecar, Node
  participant C as refs core
  participant O as Ollama

  U->>R: hotkey
  R->>W: show window, popup-shown event
  loop each keystroke
    U->>W: type
    W->>S: search, keyword pass, seq n
    S->>C: hybridSearch without a client (FTS5 bm25)
    S-->>W: hits, under 100 ms
  end
  Note over W: typing pauses for 250 ms
  W->>S: search, hybrid pass, seq n
  S->>O: health check, then embed the query
  alt Ollama answers
    O-->>S: query vector
    S->>C: cosine over stored vectors, rank fusion, project boost
    S-->>W: re-ranked hits
  else Ollama down
    S-->>W: keyword hits and a "keyword only" notice
  end
  Note over S,W: a reply for an older seq is marked superseded and ignored
  U->>W: Enter
  W->>S: preview id, section
  S->>C: sheetSections, renderMarkdown, logUsage open via popup
  S->>C: tryRefreshHookCache, so the sheet leaves try:
  S-->>W: sanitized HTML, original image for OCR sources
  U->>W: Alt+L
  W->>S: learned id
  S->>C: setLearned, waits up to 2 s for refs.lock
  alt lock held by another writer
    S-->>W: error busy, shown as a warning
  else lock taken
    C->>C: manifest.json, Git commit, hook cache refresh
    S-->>W: learned
  end
```

## refs index

The one place where slow work happens. Task Scheduler runs it at logon and every 30 minutes; a scheduled run that finds the lock taken exits quietly.

```mermaid
flowchart LR
  start(["refs index"]) --> lock{"refs.lock free?"}
  lock -->|"no, scheduled run"| quiet(["exit quietly"])
  lock -->|"no, from a terminal"| busy(["wait up to 10 s, then report busy"])
  lock -->|yes| sync["syncLibrary: edited sheets<br/>extracted and scanned again,<br/>renames matched by SHA256;<br/>--rebuild deletes index.db"]
  sync --> kind{"processInbox:<br/>each inbox file"}
  kind -->|"same SHA256"| dup["to _duplicates,<br/>with a reason file"]
  kind -->|"likely secret"| blocked["to _blocked, reason<br/>names line and rule"]
  kind -->|"image, Ollama down"| waits["stays in the inbox"]
  kind -->|clean| imported["into sheets as pending,<br/>tags proposed or queued, commit"]
  dup --> work
  blocked --> work
  waits --> work
  imported --> work["retagQueued if Ollama is up<br/>indexLibrary into FTS5<br/>embedIndex for new text<br/>if Ollama is up"]
  work --> cache(["scan projects with rules.json<br/>write the hook cache atomically<br/>release the lock"])
```

## Data model

`manifest.json` in the library is the source of truth. `index.db` (SQLite in WAL mode) is derived from it and from the sheet files, so `refs index --rebuild` can recreate it at any time. Vectors are keyed by the hash of the text they embed, so an edit re-embeds only the sections that changed.

```mermaid
erDiagram
  MANIFEST_ENTRY ||--|| sheets : "indexed as"
  sheets ||--o{ sections : "split by heading"
  sections ||--|| sections_fts : "rowid is sections.id"
  sections }o--o| embeddings : "text hash"

  MANIFEST_ENTRY {
    string id PK "s_0001"
    string file "sheets/s_0001-docker-basics.md"
    string sha256
    string status "pending, verified or draft"
    string source "imported or llm"
    bool learned "retires reminders"
    date lastVerified "stale after 180 days by default"
  }
  sheets {
    TEXT id PK
    TEXT sha256
    TEXT meta "title and tags as indexed"
  }
  sections {
    INTEGER id PK
    TEXT sheet_id FK
    INTEGER idx "1-based section number"
    TEXT heading
    TEXT text
    TEXT hash "of the text"
  }
  sections_fts {
    TEXT title "weighted 5"
    TEXT heading "weighted 3"
    TEXT text "weighted 1"
    TEXT tags "weighted 4"
  }
  embeddings {
    TEXT hash PK
    TEXT model PK "for example bge-m3"
    BLOB vec "normalized float32"
  }
```

## Trust boundaries

| Boundary | Risk | Where the code handles it |
|---|---|---|
| Files you import (CLI or inbox) | Secrets end up in a Git repo and in an AI prompt | `secrets.ts` `scanSecrets` runs on every import, OCR text included, before anything moves; `import.ts` `importPrepared`, `inbox.ts` `processInbox` parks blocked files in `_blocked` |
| A file tracked by another repo | Moving it silently deletes it there | `import.ts`: `trackingRepo` check asks first or needs `--yes` |
| Model replies (tags, suggestions, drafts) | Malformed or injected output | `llm.ts`, `suggest.ts`, `drafts.ts`: strict zod schemas, one retry at temperature 0, otherwise discarded; nothing a model returns is run |
| Project files read by `refs suggest` | Prompt injection from a README | `suggest.ts` wraps them in `<project_files>` as untrusted data and drops items without a detected tag |
| Sheet text sent to agents | A sheet that reads like instructions | `agent.ts` `wrapReferenceData`: JSON inside `<reference_data>` that sheet text cannot close early |
| Sheet text shown in the popup | Script or tracking in a Markdown file | `sidecar/src/markdown.ts`: raw HTML escaped, only http, https and mailto links, images only from the library; CSP in `tauri.conf.json`; navigation guard in `main.rs` |
| Links clicked in the popup | Opening `file:` or custom schemes | `sidecar/src/handlers.ts` `openLink` allows http, https and mailto only |
| Your machine (profiles, scheduler, PATH, Run key, agent configs) | Unwanted or lost settings | `install.ts` and `agents.ts`: every change is planned and shown first, `--dry-run`, confirmation, backups; files with comments are never rewritten |
| Two writers at once | A torn manifest or cache | `lock.ts` `acquireLock`, `util.ts` `writeFileAtomic` (temp file then rename) |
| The network | Data leaving the machine | Only the configured Ollama host is called (`ollama.ts`); tests make any call to port 11434 throw (`core/test/helpers.ts`) |

## Where to look in the code

| Question | Open |
|---|---|
| How does an import work, from file to commit? | `packages/core/src/import.ts` `importPrepared` |
| How are search results ranked? | `packages/core/src/search.ts` `hybridSearch`, `fuseRanks` |
| What does `refs index` do, in order? | `packages/core/src/indexer.ts` `runIndex` |
| How is a project's type detected? | `packages/core/src/rules.ts` `detectTags`, `packages/core/src/detect.ts` `resolveProjectRoot` |
| How does the prompt hook stay fast? | `shell/refs-hook.ps1` `Invoke-RefsHook`, `packages/core/src/hookcache.ts` `serializeHookCache` |
| Which sheets get a "try:" reminder? | `packages/core/src/usage.ts` `unusedSheets` |
| What do agents see? | `packages/mcp/src/server.ts`, `packages/core/src/agent.ts`, `packages/core/src/context.ts` `buildContext` |
| How does the popup talk to Node? | `apps/popup/src-tauri/src/main.rs` `supervise`, `packages/sidecar/src/handlers.ts` `createHandlers` |
| How are keystroke searches scheduled? | `apps/popup/src/logic.ts` `SearchScheduler` |
| What does `refs install` change? | `packages/core/src/install.ts` `planInstall`, `planPopupLogon`; `packages/core/src/agents.ts` `planAgents` |
| How do tests stay off the real machine? | `packages/core/test/helpers.ts` `setupEnv`, `fakeSystem`; `packages/core/test/fakeollama.ts` |

The reasons behind these choices, and what they cost, are in [decisions.md](decisions.md).
