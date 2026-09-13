# PawWork Architecture

How PawWork is put together: an Electron shell that owns the window and the process lifecycle, a DeepSeek Harness (DSH) sidecar that owns the agent, and a product layer of DSH plugins that makes the two one application.

Paths are relative to the repository root.

## Contents

- [What PawWork is](#what-pawwork-is)
- [Three layers, one runtime](#three-layers-one-runtime)
- [Two processes and one loopback URL](#two-processes-and-one-loopback-url)
- [The launch sequence](#the-launch-sequence)
- [The DSH home and the product overlay](#the-dsh-home-and-the-product-overlay)
- [The composition patch](#the-composition-patch)
- [The product plugins](#the-product-plugins)
- [Models and the free tier](#models-and-the-free-tier)
- [Web search](#web-search)
- [Automations](#automations)
- [Office skills and the bundled Python](#office-skills-and-the-bundled-python)
- [What the code enforces](#what-the-code-enforces)
- [Build and packaging](#build-and-packaging)
- [Release and update](#release-and-update)
- [Tests and CI](#tests-and-ci)
- [The site](#the-site)
- [Scope of this document](#scope-of-this-document)

## What PawWork is

PawWork (爪印) is a desktop AI agent for macOS and Windows, aimed at someone who has never opened a terminal: free models included, no API key, Office document skills and a Python toolchain bundled, and a native shell rather than the DSH web UI loaded in a window.

The agent runtime is not vendored here. `packages/desktop-electron/package.json` pins 34 first-party `@deepseek-ai/dsh*` packages, every one at the same version, and the app assembles them in a sidecar process. What this repository holds is everything around that runtime: the shell, the plugins that shape the runtime into a product, the bundled skills, the packaging and release machinery, and the landing page.

## Three layers, one runtime

The repository is a pnpm workspace with two members (`pnpm-workspace.yaml`). Inside the desktop package the code splits by which side of the process boundary it runs on.

| Layer | Path | Runs in |
|---|---|---|
| Native shell | `packages/desktop-electron/src/main` | Electron main process |
| Product plugins | `packages/desktop-electron/resources/dsh` | The DSH sidecar and the DSH web UI |
| Office skills | `skills/` | Bundled `uv` Python, spawned by the agent |
| Landing page | `site/` | Astro static build on Cloudflare Pages |
| Build and release | `packages/desktop-electron/scripts`, `.github/workflows` | CI runners |

The shell is TypeScript bundled by electron-vite. The product plugins ship as plain JavaScript — `.cjs` and `.mjs`, unbundled, copied verbatim into the packaged app — because DSH's own module loader reads them at runtime, not the app's bundler. That split is why `pnpm --filter @pawwork/desktop test` runs two test runners.

## Two processes and one loopback URL

PawWork neither embeds DSH in the main process nor shells out to a `dsh` CLI on the user's PATH. It spawns the Electron binary a second time in Node mode and hands it DSH's own entry point (`src/main/dsh-sidecar.ts`):

```
<electron> --expose-internals --import <sidecar-preload.mjs> \
  <dsh>/lib/bin.js web --patch <product.cordis.patch.yml> \
  --host 127.0.0.1 --port 0 --no-open

env:   ELECTRON_RUN_AS_NODE=1, DSH_HOME=<home>,
       PAWWORK_HOST_TOKEN=<uuid>, DSH_BUNDLED_SKILL_DIR=<skills>
stdio: [ignore, pipe, pipe, ipc]
```

Port `0` lets the OS pick, so the shell cannot know the URL in advance. DSH's human-readable `dsh web: <url>` line is silenced in the patch; instead the `pawwork-web-ready` plugin, mounted inside the sidecar, sends the authenticated root URL back over the IPC channel the spawn already opened (`resources/dsh/product/lib/web-ready.js`). That file records why: the log line is addressed to a person, it grew a `(LAN: …)` suffix, it shares a prefix with the browser-handoff line beside it, and parsing it would route the launch token through the persistent application log.

The token in that URL is the bootstrap, not a per-request credential. Loading the root with it mints an authority-bound signed cookie that every later request rides on — index and `/api` alike — and that cookie outlives the token, so a window already holding one keeps working across a restart that mints a new one. A root request with neither answers 401.

The shell drives the rest through a state machine in `src/main/dsh-lifecycle.ts`:

```
stopped → starting → loading → ready → stopping → stopped
                        ↘        ↘
                         failed (reason: "startup" | "crash")
```

Two timing decisions are deliberate. There is **no readiness deadline** on the sidecar: the sidecar says nothing until it is ready, so elapsed silence cannot distinguish a wedged runtime from a slow one — a first launch behind an antivirus scan of freshly unpacked files looks exactly like a hang, and a deadline only ever killed starts that were about to succeed (#1614). The failures that are real announce themselves: the process exits, or the spawn errors. There **is** a 30-second deadline on the next hop, in `DshLifecycle`: once DSH reports a URL, the renderer must call back `pawwork:product-ready` or the launch fails.

## The launch sequence

From `src/main/index.ts`. Several steps exist only because they must precede another.

1. **Probe the login shell's PATH (macOS).** A GUI launch inherits launchd's minimal PATH, so user-installed CLIs are invisible to every child. `user-shell-env.ts` runs the login shell with `-i`, fences the output with a marker, and merges the result, capped at 5 seconds. Started early so it overlaps Electron setup; awaited immediately before the first spawn.
2. **Claim the single-instance lock, after `ready`.** Deliberately after: a process that requests the lock before `ready` and loses never becomes ready, so it could only exit in silence. The loser shows a bilingual notice instead.
3. **Open the window and build the menu.** Both before anything that can fail, so every DSH failure has a surface to be reported on. The window sits on a self-contained `data:` startup page whose CSP is `default-src 'none'`.
4. **Migrate the DSH home, then prepare the overlay.** The migration is passed as an argument to `prepareDshProductHome` rather than run as a preceding statement, so it cannot be reordered: an overlay written first would make the new home look already migrated.
5. **Verify the community plugin market.** `dsh-market-guard.ts` runs before DSH loads the profile. A profile that boots the market below the version this build was verified against is upgraded synchronously, behind a named notice on the startup page — DSH prints nothing until it is ready, so an unnamed wait in front of it reads as a frozen app.
6. **Spawn the sidecar and wait for the IPC message.** Both child streams are forwarded whole and unbuffered to `electron-log`; the last 40 KB of stderr is also kept in memory, because once DSH is gone its stdio is gone with it and that tail is the only copy of its own explanation.
7. **Navigate, and let the renderer confirm.** The preload's `pawworkLifecycle.ready()` fires `pawwork:product-ready`, the lifecycle reaches `ready`, and the update scheduler runs its first silent check.

### When it fails instead

A failure opens a native dialog offering *Try Again*, *Show Log*, *Report a Problem* and *Quit*. Before that, `dsh-profile-repair.ts` reads the captured output for two patterns that distinguish a plugin which is missing from one which is installed but incompatible. When either matches, a fifth button appears — *Remove Plugin and Retry* — which edits the offending row out of the profile manifest. Both cases are otherwise unrecoverable: the loader rolls the whole configuration tree back, so one stale plugin leaves the app unopenable and a plain retry cannot change the outcome. A removal that matches no declared row is reported as a failed repair rather than a repair that did not happen.

## The DSH home and the product overlay

Agent data lives in a dotdir under the user's home, the way Claude Code and Codex do, rather than in Electron's userData (`src/main/pawwork-home.ts`).

| Location | Holds |
|---|---|
| `~/.pawwork/dsh` (prod), `~/.pawwork/dsh-dev` (dev) | `DSH_HOME`: sessions, settings, the profile, `automations.json`, `session-query.sqlite`, the product plugin overlay |
| `<userData>/` | Chromium's own state, logs, window state, the updater cache |
| `<userData>/dsh` | The legacy home, migrated once and then discarded |

The migration is written around a commit point. A same-filesystem `rename` is the fast path; `EXDEV` falls back to copying into a sibling staging directory, reading the copy back entry by entry, and only then renaming it into place. Any failure before the commit deletes the partial destination and returns the *legacy* path, so a botched migration degrades to the old location instead of an app that cannot start. Past the commit, tidying up is best-effort: failing to remove the old directory must not undo a move that already succeeded.

On every launch `prepareDshProductHome` (`src/main/dsh-product-home.ts`) rebuilds the overlay inside that home:

- `resources/dsh/home/` is copied over the home, which is what places `product.cordis.patch.yml` and the `import-v1` plugin.
- Five plugin directories are copied to `<home>/node_modules/@pawwork/dsh-{product,automations,identity,web-search,updater}`.
- The app's own `node_modules/@deepseek-ai` is linked into the home (a junction on Windows). Product plugins resolve upward from the home, so without this link they never reach the harness packages the running app loaded, and could bind a second copy at a different version. A missing scope throws rather than degrading, because the quiet failure is every `web_search` answering that the configured provider is not registered. The link is compared with `lstat` rather than `exists`, because the link it replaces is usually dangling — "run once from Downloads, then drag to Applications" moves the host tree out from under it.
- A `.tools` directory (mode 0700) receives `node` and `pnpm` shims that exec the bundled runtime, and is prepended to PATH together with `resources/tools`, where the bundled `uv` lives.

The launch environment is also scrubbed (`buildDshEnvironment`): the product's own model variables are dropped and the free-tier credential is seeded. The drop is keyed on the lowercased name, because Windows treats environment names case-insensitively while the JavaScript object does not, so an exported `opencode_api_key` would otherwise survive beside the name meant to replace it.

## The composition patch

PawWork does not fork DSH's web profile; it patches it. `resources/dsh/home/product.cordis.patch.yml` is applied after the official profile via `--patch`, and it is the densest file in the repository — roughly half comment, arguing each row. A patch replaces the targeted row's whole config, which is why rows PawWork only partly cares about restate the keys it does not choose.

| Row | Change |
|---|---|
| `agent-default-model` | Default to the free OpenCode model |
| `llm-pi-ai` | Two OpenCode Free routes, one per wire protocol, pinned to the zen gateway |
| `llm-deepseek` | Disabled |
| `web-runtime` | Silence the printed URL; the other keys restated verbatim |
| `web` | `searchProvider: pawwork`, `fetchProvider: http` |
| `web-search-deepseek` | Disabled: its settings card would edit a provider the seam can never select |
| `tool-web` | Re-enabled with `search: false, fetch: true`, putting `web_fetch` in the global tool layer every preset inherits |
| `session-query-sqlite` | A durable file instead of `:memory:`, opened lazily at first search |
| `directory-picker` | Disabled on Windows; the out-of-process browse host/client pair is inserted instead |
| `dsh-market` | Injected with the Desktop services, which select the managed package runtime and make self-restart unavailable |
| inserts | The seven PawWork plugins, plus `time-context` at a 60-second floor — without it the model has no clock |

Three of its comments are design records rather than notes.

The `session-query-sqlite` row states what moving off `:memory:` costs: the FTS5 table is not contentless, so message text — tool-call arguments and results included — now lives in a searchable file at rest; deleting a session does not clear it until a later search reconciles; and the backfill is all-or-nothing and restarts on the sidebar's own abort signal, so editing the query mid-flight starts it over.

The `tool-web` row states the residual risk of `web_fetch` plainly. The fetch provider does defend the destination — it validates one DNS answer set, rejects non-public addresses, pins the resolved address for the transport, refuses credentials in the URL, and does not follow cross-origin redirects — but none of that addresses the direction the risk actually runs: page text is attacker-controlled and the next URL is the model's to choose, so context can leave in a query string to a perfectly public host. PawWork accepts that because `bash` already egresses unprompted inside its sandbox, and names `tools/pre-execute` as where a real mitigation would live.

The `pawwork-web-ready` insert states why readiness is its own entry rather than a line inside `pawwork-product`: readiness needs two services, and an entry that also carried the catalog refresher, the Desktop services and the market routes would be an entry any of those could keep from ever reporting.

## The product plugins

Each is a DSH plugin with an `inject` list and an `apply(ctx)`. Several ship a matching `client.js` that runs in the DSH web UI through the host module loader and injects React nodes into named slots.

| Plugin | Host side | UI side |
|---|---|---|
| `pawwork-web-ready` | Announces the URL over IPC | — |
| `pawwork-product` | OpenCode catalog refresh; the Desktop profile and pnpm services; community-market HTTP routes | Window chrome, sidebar toggle, brand marks, file-picker action, community-market settings tab |
| `pawwork-identity` | One system-prompt section | — |
| `pawwork-automations` | Store, scheduler, executor, six agent tools, a management RPC channel | Automation list, editor, date popout |
| `pawwork-web-search` | One search provider with two selectable engines | Settings card for the engine and its keys |
| `pawwork-updater` | A deliberate no-op: the state machine lives in the Electron main process | Settings section, ready toast, sidebar indicator |
| `pawwork-import-v1` | One-time migration from PawWork v1 | Dismissible import notice |

### The identity section

The product name reaches the model as a system-prompt section rather than a config toggle (`resources/dsh/identity/index.js`). The harness opener says only that it is powered by DeepSeek Harness, and each shipped preset mounts its own persona row that shadows a deployment persona — so a *new* section name in the global layer is what a preset does not shadow, because shadowing is per name. Its order places it after the harness identity and before the persona, and the harness opener stays: PawWork is built on DSH, and the attribution should say so.

One preset is outside that reach. The pinned release ships `standard`, `minimal`, `ptc` and `cordis`, and `minimal` mounts its persona with `complete: true`, which its own composition documents as "the persona is the complete system prompt, so global identity, Web orientation, tool guidance, and later assembly listeners cannot add prompt text". A session on `minimal` therefore does not carry the product name. The plugin's comment says otherwise, and names a `code` preset the pinned release does not ship.

### The v1 importer

`resources/dsh/home/plugins/import-v1/` reads PawWork v1's SQLite database read-only, snapshots it, and replays sessions, settings and automations into DSH. It is resumable: a stored session that stops short of the seed is an interrupted earlier import, and only the missing tail is appended, because the id cannot be created a second time. Each stage is caught individually so one failure cannot take the backend down, and the snapshot is closed in a `finally` that is the only statement allowed to reject the task.

## Models and the free tier

The packaged model list is a floor, not the answer. `resources/dsh/product/lib/opencode-free.cjs` fetches the models.dev catalog at startup and every hour, selects the non-deprecated free models, and rewrites the `llm-pi-ai` settings namespace.

- **Free is fail-closed.** `isZeroCost` walks the whole cost object and requires every numeric leaf to be zero; a missing or non-object cost, or missing pricing fields, is not free. The structural `tier` key is skipped.
- **Protocol is per route.** The gateway serves one wire protocol per model and a route carries one protocol for all of its models, so the free set is split across two routes keyed on the catalog's own provider marker. A free model marked for a protocol no route claims is left out and logged rather than routed somewhere it would fail every attempt.
- **Failure is inert.** A fetch error, a parse error or an empty result leaves the packaged list untouched, because an empty configured list means "serve the entire bundled catalog" — writing `[]` would be worse than writing nothing. A route the live catalog has nothing for keeps its packaged list for the same reason.
- **The default is repaired.** If a refresh retires the shipped default, the selection moves to the first surviving model, preferring the route the retired default sat on so the replacement keeps its protocol. A default on another provider is left alone.
- **Writes are skipped when nothing changed**, and the settings descriptor is re-read immediately before committing so a concurrent edit is rejected by revision rather than clobbered.

### Speaking the gateway's dialect

`resources/dsh/zen-identity.mjs` is loaded with `node --import` ahead of DSH and wraps global `fetch`. For zen-gateway requests only, it sets the official client's user-agent headers and restates the harness session id — which the adapter already writes under its own header name — under the name the gateway requires. It is a preload because neither header can be set from configuration. A route profile does carry a `headers` field, but the harness attribution wins the reserved names, so `User-Agent` cannot be overridden there; and the session header's value changes per request, so no static field can carry it.

The free-tier credential is supplied through the launch environment rather than the credential store, which makes it read-only in the UI: the Models page renders the field disabled, and a write is refused rather than silently shadowed.

Two of the three entries in `patches/` exist for this path, each carrying a note naming the upstream change that would let it be dropped.

## Web search

The web seam selects one search provider id from static entry config, with no settings namespace behind it, so a user-visible engine choice cannot be expressed as two entries. PawWork registers one provider and puts the choice inside it (`resources/dsh/web-search/lib/index.js`).

| Selection | Path | Result |
|---|---|---|
| Exa, key held | Exa's official search API | Structured results with sources |
| Exa, no key | Exa's hosted MCP endpoint, unauthenticated | A prose report as `content`, no sources |
| DeepSeek | DeepSeek's server-side search | Structured; refuses with a message naming the settings card when no key is held |

The keyless path is what makes search work on first run. `exa-mcp.js` records why it returns no sources rather than synthesizing them: the report is verbatim page text with no marker separating the service's structure from a page's content, so any splitting rule would mint attributions this product cannot verify. It prepends a preamble telling the model the report is third-party page content and that instructions inside it are data to report, never to follow. It also names both remedies when the shared allowance fails, because a spent allowance, a throttle and an outage are reported identically.

Keys are resolved per search rather than held, so a key entered in the card reaches the next search without a restart, and the resolved value is trimmed — a trailing newline from an editor or a shell export would otherwise count as a key and send the search to an endpoint that rejects it instead of to the allowance that would have answered.

## Automations

Automations are PawWork's own feature, in `resources/dsh/automations/`, built from four parts:

- **Store** — one JSON document at `<DSH_HOME>/automations.json`, written atomically (temp file, then rename, mode 0600) with an in-memory rollback to the last durable copy if the write throws.
- **Scheduler** — a single timer armed at the earliest next fire time, capped at the maximum timer delay and unreferenced so it cannot hold the process open. Due definitions are *claimed*: the claim advances the next fire time and appends the run record in the same save, so a claim that could not be persisted is retried later rather than on the next tick.
- **Executor** — creates or resumes a DSH agent, renames a fresh session, sends the saved prompt as a follow-up, waits for idle, and reads the assistant text out of the new turn.
- **Surfaces** — six agent tools (`automation_create`, `_list`, `_update`, `_set_paused`, `_run_now`, `_delete`) and one RPC channel, `/pawwork-automations`, for the UI.

### The rules that make it durable

Startup marks any run still recorded as running as stopped and interrupted: the process that owned it is gone. Schedules that came due while the app was closed are claimed as missed rather than fired late, and a definition whose previous run is still active records that instead of overlapping. Intervals have a 30-second floor. A one-shot that lost its moment reports as missed, not completed, so the list can say which. Completion validates the outcome before touching the record, so a rejected outcome cannot leave a run completed in memory and running on disk.

### Cron without a dependency

`automation-cron.cjs` is a five-field cron evaluator that is timezone-correct through `Intl.DateTimeFormat` rather than a library. The daylight-saving handling is the substance: for each candidate wall time it probes zone offsets across a ±36-hour window, maps them to instants, and keeps only those that format back to the same wall time — which yields both instants on a fall-back day and none inside a spring-forward gap. Day-of-month and weekday follow the usual OR rule when both are restricted, and lookahead is bounded.

### Automations cannot manage automations

A fresh run's session id is derived from the run id, and tool registration skips exactly those sessions. A continue-mode run shares the user's session, where the tools are registered for the user, so every tool call additionally checks whether an automation run is active in the calling session. Both rules derive from one prefix constant: stated separately, a change to the run-id format silently re-armed the tools inside runs.

## Office skills and the bundled Python

Four skills ship in `skills/`, each a `SKILL.md` plus a pinned `pyproject.toml`: `office-docx`, `office-xlsx`, `office-pptx` and `office-pdf`. They run through the bundled `uv`, and each instructs the agent to stop with an exact message rather than fall back to `pip` when `uv` is missing, because a missing `uv` is an environment fault rather than something to work around. The skill directory ships read-only inside the bundle, so work happens in a fresh directory.

Two license rules are stated in prose because they cannot be stated in code: `office-pdf` forbids PyMuPDF outright as AGPL and generates PDFs through the bundled Chromium's print path rather than an external renderer, and `office-pptx` builds native decks by authoring one SVG per slide and converting with a vendored SVG-to-DrawingML engine. `skills/office-pptx/VENDORED.md` records the upstream tag and commit, what was taken, what was omitted and why each omission is safe, and that no vendored source file was patched.

## What the code enforces

The product frame is a full-privilege surface: anything running in it, plugins included, can reach the exposed bridges, and a frame check cannot tell a plugin from the settings page. Several controls exist because of that.

- **Renderer** — `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` (`src/main/window-options.ts`). The preload exposes four narrow bridges and nothing else.
- **Navigation** — one decision function (`src/main/window-navigation.ts`) classifies every target as same-origin, external http(s), or denied. Popups are always denied and the destination re-homed by the same rule, so a privileged scheme reaches neither the window nor the browser.
- **IPC** — every privileged handler re-checks that the sender is the main frame and same-origin with the live DSH URL, and refuses while DSH is not ready.
- **Community market** — enabling or disabling it raises a native confirmation dialog before acting, so the decision to hand third-party code PawWork's permissions is made outside the page. The HTTP routes behind it additionally require a per-launch host token.
- **Plugin RPC channels** — `/pawwork-automations` and `/pawwork-import-v1` are ordinary DSH Connection channels, carrying the protection every DSH RPC channel carries and no more: the Host/Origin trust fence, then the browser-session cookie, both answered before the handler runs. DSH has no per-channel authority tier. They are reachable only from this machine because the sidecar binds loopback, and only from this app's own pages because the cookie is minted by a `GET` of the launch URL.
- **Supply chain** — `uv` is pinned by version and by sha256 in `packages/desktop-electron/bundled-tools.json`, checked into the repository rather than fetched from the release it is meant to verify, so moving to a new upstream build always requires a reviewed manifest diff.
- **Proxy** — loopback is added to `NO_PROXY` and to Chromium's bypass list, so a corporate proxy cannot sit between the app and its own sidecar.

## Build and packaging

`electron-vite` bundles only the main process; there is no renderer build, because the UI is DSH's own web app served by the sidecar. The channel is baked in at build time and anything unrecognized resolves to `dev`: dev profile, dev appId, updater off (`src/main/app-identity.ts`).

`electron-builder.config.ts` makes three packaging decisions that are each load-bearing:

- **`asar: false`** — the plain-Node sidecar needs real dependency paths on disk, and an `app.asar.unpacked` directory triggers node-pty's ASAR rewrite a second time.
- **Declaration files and source maps are excluded**, as is pnpm's duplicate CLI copy. The dependency closure ships around twenty thousand files and a fifth of them are never loaded at runtime; the win is less the installed footprint than the file count signing and notarization have to walk. Documentation is deliberately kept, because the closure uses Markdown as real payload.
- **The packaged package name is pinned** to a stem that sanitizes to itself, because electron-builder derives the updater cache directory from it and the NSIS uninstaller's data removal reads the same value. Left at its default the scoped workspace name would sanitize to something else, and the app would clear a directory the updater never writes to.

Extra resources are the product plugin tree (minus its tests), the icons, the whole `skills/` directory, the third-party notices, and `resources/tools/`, where `scripts/prepare-uv.ts` has placed the verified `uv` binary. macOS builds use the hardened runtime, are entitled and notarized, and carry localized display names written in `afterPack` so the app is named 爪印 on a Chinese system. Windows ships an NSIS installer with a bilingual UI.

## Release and update

Releases run from `.github/workflows/build.yml` by manual dispatch, with phases `submit`, `finalize` and `full`, one target and architecture per run. The split exists because Apple notarization is asynchronous: `submit` signs, packages, smokes and submits; `finalize` re-downloads the signed artifact, staples, packages the disk image and uploads. Every script derives its slice of the target matrix from one table in `scripts/release-targets.ts`.

Assembling one version across several independent runs is guarded by `scripts/publish-when-complete.ts`, which fails closed in three layers: each target uploads a distinct marker holding its build commit and the installer's hash; every marker's hash must still be present in the current updater metadata before publishing; and the release is re-read after a settle window. Concurrent targets built from different commits leave disagreeing markers, and no run ever sees them agree. `scripts/ensure-release-draft.ts` guarantees exactly one draft exists before uploads start, because electron-builder's concurrent uploads each create the release when it is missing, which otherwise splits one tag's assets across two drafts and surfaces as a checksum failure much later.

Published releases are mirrored to Cloudflare R2 — immutable installers first, the mutable pointers last, so a failed mirror leaves the site on the previous good release. The in-app updater prefers that mirror and falls back to GitHub (`src/main/update-feed.ts`). Selection uses a cancellable reachability probe and then a strictly sequential check, never a concurrent one: electron-updater's check cannot be cancelled and mutates a shared provider, so racing two feeds would let the slower one resolve late and silently rebind the download to the wrong feed. The updater is active only in packaged production builds, re-checks on a fixed cadence, and never downloads without being asked.

## Tests and CI

Tests are split by runtime: Vitest for the TypeScript, and `node --test` for the product plugins, which ship as plain JavaScript. `pnpm --filter @pawwork/desktop test` runs both. Several tests assert on things that are not TypeScript: the NSIS contract test pins strings in `resources/installer.nsh`, which cannot import TypeScript, and the market guard test fails until a DSH upgrade names the market release it was validated with.

`.github/workflows/ci.yml` runs typecheck, lint, tests and a dependency audit on Linux, then a three-way package matrix — macOS arm64, macOS x64 and Windows x64 — each of which packages the app and drives the real packaged binary over the Chrome DevTools Protocol.

That smoke run (`scripts/ci-smoke.ts`) is the load-bearing integration test. It seeds a v1 database in the legacy home, launches the app, and asserts on the running product: that the v1 session was imported and appeared in the sidebar without a reload, that a real free-model turn completes, that all four Office skills are present, that the automation editor creates, saves, pauses and deletes through the visible form, and a long list of window-chrome invariants — drag region, native control overlap, sidebar alignment, cursor correctness. The cursor probe plants two deliberate mismatches and fails if it does not catch both, so a probe that has stopped working cannot pass as a clean result.

## The site

`site/` is a small Astro static build deployed to Cloudflare Pages, decoupled from the app build. Both languages render as their own page at build time from one dictionary in `site/src/i18n.ts`; there is no client-side language swap. The download buttons ship pointing at GitHub Releases and are upgraded on load by fetching the pointer object the release mirror rewrites, so if that is unreachable the GitHub fallback stands and the buttons always work.

## Scope of this document

This describes PawWork's own code. DSH is a pinned dependency and is not vendored here, so where this document describes DSH behaviour — service names, patch semantics, loader rules, slot contracts — it describes it as PawWork's code and comments rely on it at the pinned version. Treat the pinned version as part of every such statement: a DSH upgrade is the moment to re-read them.

Where this document explains why something is built the way it is, the reasoning is generally recorded in the code itself. The comments at the point of implementation are the authority; this is a map to them.
