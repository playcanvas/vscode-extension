# AGENTS.md - PlayCanvas VS Code Extension

VS Code extension for real-time collaborative editing of PlayCanvas assets. Syncs bidirectionally with PlayCanvas Editor via ShareDB (Operational Transform). Many users can be connected to the same project at once — a bug on this side can corrupt state for all of them, so the rules in the Invariants section below are non-negotiable.

## Invariants (must not violate)

### OT compliance

- All buffer mutations flow through `OTDocument.apply()` (`src/utils/ot-document.ts`). `OTDocument` is a thin wrapper around the ShareDB `Doc` — `text` reads `doc.data` directly, with no parallel cache, mirroring the online code editor (`editor/src/code-editor/monaco/sharedb.ts`). `apply()` just calls `submitOp`; ShareDB handles the optimistic apply (and the rollback on rejection) on `doc.data` directly, so there's nothing to drift.
- Local edits: convert `contentChanges` via `vscode2sharedb()` in `src/utils/text.ts`. Adjust each change's offset by the cumulative `insertLength − deleteLength` of preceding changes in the same batch — raw `contentChanges` offsets are relative to the pre-batch buffer and will misalign if applied naively.
- Replace ops use the atomic form `[offset, text, { d: len }]`. Never emit separate delete+insert for a replace, and never emit a leading `0` skip (ot-text rejects it).
- Remote ops are applied under the per-URI lock `_locks` (`src/disk.ts`). While the lock is held, `onDidChangeTextDocument` must not submit ops; post-lock reconciliation in `_update` recovers keystrokes typed during `applyEdit` by diffing observed-vs-expected and transforming against queued ops.
- `_update`'s pre-`applyEdit` resubmission must use `delta(prev, bufferText)` (the lock-window-bailed keystrokes) — never a delta against any older baseline. `prev` is `OTDocument._text` immediately before the remote op was applied, which already includes every keystroke the handler processed via `apply()`. Computing the resubmission off something stale (e.g. `_bufferState` from the previous `_update`) re-submits already-acked keystrokes; the server applies them again at offsets shifted by the remote op, producing silent positional divergence.
- **Server is authoritative on reconciliation.** On `_create`, `_subscribed`, and closed-file remote updates, divergent disk content is overwritten by the server snapshot — never push local disk upstream as part of open/subscribe/reopen. Local edits reach the server only via `onDidChangeTextDocument` (keystrokes) and the disk watcher's explicit `change` event (external file edits). Accept the narrow loss of watcher-blind external edits rather than risk collab data loss from stale local files clobbering server state.
- `UndoManager` (`src/undo-manager.ts`) stores inverses of **local edits only**. On every remote op, call `transform()` to rebase both stacks; `clear()` on document reload. Route undo/redo through `OTDocument.apply()` — never mutate `doc.text` directly.
- On `OTDocument` `reload` (ingestSnapshot, fresh subscribe, or submit-op rejection): take `_writeMutex` for the URI, apply server content to the buffer via `applyEdit`, then clear undo/redo. Never submit buffer content upstream during subscribe. Snapshot resyncs are a normal ShareDB recovery path (reconnect, version mismatch) — recover silently, don't surface a desync toast on `load`; that's how the online IDE behaves and surfacing it produces false positives on every reconnect.
- OT canonical state is LF. All text crossing the disk↔server boundary is normalized via `norm()` (`src/utils/text.ts`); `files.eol` is forced to `\n` at workspace level. Never compare raw disk bytes against server-produced bytes — always compare normalized strings.
- Do not rely on `fs.writeFile` to an open document triggering VS Code's native reload — use the buffer-apply path.

### Data integrity (one client must not corrupt others)

- File I/O: always `vscode.workspace.fs`, never Node `fs`.
- Feedback loop guard: every disk mutation pre-sets an echo hash keyed `${uri}:create|change|delete` in `Disk`. The disk watcher must skip events whose hash matches (no-op) or is superseded by newer on-disk content. Do not write to disk without setting an echo first.
- `_diskHash` and `_diskStat` must be deleted whenever the file is deleted, renamed, or unlinked. Stale entries cause false "divergent" merges on re-create.
- Deletes are batched deepest-first and use non-recursive `fs.delete`. Folders become empty before removal, so a parent-delete can never cascade into server-side asset deletions.
- VCS and editor-config directories are hard-excluded via `Disk.VCS_IGNORE` (`.git`, `.hg`, `.svn`, `.vscode`, `.cursor`) prepended to `.pcignore`. Do not remove the prefix — `.vscode` in particular holds our own workspace settings (`files.autoSave`, `files.eol`) and would otherwise round-trip to the server and collide; `.cursor` is Cursor's equivalent.
- `CollisionManager` (`src/collision-manager.ts`) blocks loading two assets that map to the same disk path (same path or ancestor shadowing). Check collisions during ingestion — otherwise one asset overwrites another on link.
- Stub assets (`type: 'stub'` in `ProjectManager`) are metadata-only placeholders. Do not write them to disk or subscribe to them until explicitly opened. Deleting a stub from VS Code must not propagate an asset delete to the server.
- Never call `_dirtify` from `onDidChangeTextDocument` — causes the double-line bug. The only legitimate dirtify path is `_writeMutex`-guarded `Disk._dirty()`.
- `disk.ts` must not take a direct reference to ShareDB. Any state it needs is exposed by `ProjectManager`.
- Project-wide desync is detected when any `OTDocument` emits `stuck` (30s with no ack, or explicit server reject). `ProjectManager.desync` flips true and surfaces a status-bar item + one-shot toast. Do not silently swallow `stuck`.
- Initial link: prefetch via `FETCH_CONCURRENCY=8`, write via `pool(WRITE_CONCURRENCY=16)` grouped folders-before-files. `ProjectManager` stays unset until link completes so the file watcher cannot interfere.
- Mutexes in `Disk`:
    - `_writeMutex` (path-related matcher) guards every mutation: `_create`, `_update`, `_delete`, `_rename`, `_subscribed`, `_dirty`, `_dirtyReload`.
    - `_readMutex` guards disk-watcher reads.
    - `_locks` (per URI) blocks `onDidChangeTextDocument` during remote apply and reconciliation.

## Directory Structure

```
src/
├── extension.ts              # entry point, commands, orchestration
├── project-manager.ts        # virtual file system, asset state, desync signal
├── disk.ts                   # file system sync (ShareDB <-> VS Code)
├── auth.ts                   # OAuth authentication
├── collision-manager.ts      # path-collision detector for asset ingestion
├── undo-manager.ts           # OT-aware undo/redo with transform-on-remote
├── metrics.ts                # Graphene telemetry sender
├── sentry.ts                 # error reporter with scrubbing + fingerprinting
├── config.ts                 # environment constants
├── log.ts                    # logging utility
├── notification.ts           # progress/simple notifications
├── connections/
│   ├── sharedb.ts            # OT collaborative editing (WebSocket)
│   ├── messenger.ts          # project events (WebSocket)
│   ├── relay.ts              # presence/collaboration (WebSocket)
│   ├── rest.ts               # REST API client
│   ├── constants.ts          # shared timeouts and close codes
│   └── latency.ts            # dev-only WebSocket latency injection
├── handlers/
│   └── uri-handler.ts        # deep linking from Editor
├── providers/
│   ├── collab-provider.ts    # collaborators tree view
│   └── decoration-provider.ts # .pc/ badge + dirty-file decoration
├── utils/
│   ├── ot-document.ts        # ShareDB Doc wrapper; emits op/reload/stuck
│   ├── text.ts               # norm, diff, delta, stat, vscode2sharedb, sharedb2vscode
│   ├── buffer.ts             # TextEncoder/Decoder wrappers
│   ├── error.ts              # FingerprintedError + `fail` tagged template
│   ├── linker.ts             # Linker pattern base class
│   ├── signal.ts             # reactive state (signal/computed/effect)
│   ├── event-emitter.ts      # type-safe event emitter
│   ├── mutex.ts              # path-based mutex for atomic ops
│   ├── debouncer.ts          # key-based debouncing
│   ├── bimap.ts              # bidirectional map
│   ├── deferred.ts           # deferred promise pattern
│   └── utils.ts              # hash, tryCatch, guard, pool, withTimeout, etc.
├── typings/
│   ├── event-map.d.ts        # event type definitions
│   ├── models.d.ts           # Asset, Project, Branch, User types
│   ├── sharedb.d.ts          # ShareDB operation types
│   └── ot-text.d.ts          # ot-text module declaration
└── test/
    ├── mocks/                # mock implementations for testing
    └── suite/                # test suites (extension.test.ts + utils.test.ts)
plugin/                       # TypeScript language server plugin
scripts/                      # build & codegen scripts
```

## Key Patterns

- **Linker Pattern**: Components extend `Linker<T>` with `link()`/`unlink()` lifecycle.
- **Signal Pattern**: Reactive state via `signal()`, `computed()`, `effect()`.
- **Event-Driven**: Type-safe `EventEmitter` for component communication.
- **Mutex**: Path-based mutex (`_writeMutex`, `_readMutex`) serializes ancestor/descendant operations.
- **Debouncer**: Key-based debouncing batches disk writes (50ms default).
- **Atomic OT Ops**: Single replace ops `[offset, text, { d: len }]` instead of separate delete+insert.
- **Minimal Diff**: Prefix/suffix matching in `text.ts` `delta()` minimizes op size for closed-file updates.
- **Server-Authoritative Reconciliation**: On open/subscribe/reopen, server content overwrites divergent disk/buffer. Local edits reach the server only via keystrokes or explicit disk-watcher change events.
- **LF Canonicalization**: All text crossing disk↔server goes through `norm()`; workspace `files.eol` is forced to LF.
- **Echo Mechanism**: Hash-based echo map in `Disk`, keyed `${uri}:${kind}`, prevents feedback loops on disk writes.
- **Buffer-state tracking**: `_bufferState` holds the canonical-before-op snapshot so the next keystroke diff does not re-submit already-applied remote content.
- **Stuck → desync**: `OTDocument` emits `stuck` after 30s without ack or on explicit server reject; `ProjectManager.desync` surfaces this as a status-bar item and toast.
- **Naming**: Private members prefixed with `_`, files in kebab-case.

## Data Flow

```
Remote: ShareDB → ProjectManager → Disk → VS Code
Local:  VS Code → Disk → ProjectManager → ShareDB
```

### Sync paths

- **Local edits (open files)**: `vscode2sharedb()` (`utils/text.ts`) converts `contentChanges` into atomic ShareDB ops with per-change offset adjustment, then submits through `OTDocument.apply()`.
- **Remote edits (open files)**: `sharedb2vscode()` (`utils/text.ts`) converts ops to VS Code `TextEdit[]`, applied under the per-URI `_locks` lock. After the lock releases, reconciliation transforms any keystrokes typed during the apply window against queued remote ops so no local input is lost.
- **Closed-file remote updates**: `Disk._update` writes the server snapshot straight to disk via the debounced write — server is authoritative, no readback.
- **Closed-file local writes**: `ProjectManager.write()` computes a minimal diff via `delta()` and submits one atomic op.
- **Disk sync**: Debounced writes pre-set the echo hash; the watcher skips matching or superseded events. `_diskHash` / `_diskStat` are cleared on delete/rename/unlink so re-creates don't see false divergence.

## Commands

- `playcanvas.login` — Authenticate
- `playcanvas.logout` — Log out
- `playcanvas.openProject` — Open project
- `playcanvas.reloadProject` — Reload project
- `playcanvas.switchBranch` — Switch branch
- `playcanvas.showPathCollisions` — Show path collisions
- `playcanvas.undo` — Collaborative undo (reverts local edits only)
- `playcanvas.redo` — Collaborative redo

## Build & Test

```bash
npm run build           # production build
npm run compile         # TypeScript compile
npm run compile:plugin  # compile plugin + generate PlayCanvas types
npm run watch           # watch mode (main)
npm run watch:plugin    # watch mode (plugin)
npm run pretest         # compile tests + setup VS Code storage
npm run lint            # prettier + eslint check
npm run lint:fix        # auto-fix formatting + eslint
```

`npm test` requires a VS Code instance and network access; use `npm run lint` and `npm run pretest` to validate changes locally.

## Testing

- Integration tests live in `src/test/suite/extension.test.ts`. Add cases there; don't create new test files per feature.
- Skip integration tests for trivial visual/viewport fixes — manual repro is sufficient.
- Mocks in `src/test/mocks/` mirror the real network/auth surfaces. Extend those rather than stubbing ShareDB or the file system ad-hoc — divergence from production semantics hides real bugs.
- The OT invariants above apply to tests too: don't bypass `OTDocument.apply()` or drive edits by writing to `vscode.workspace.fs` expecting a native reload (the harness doesn't behave like a real editor session).

## PR & Git

- PR titles: describe the change; do not include issue numbers (the PR linker handles that).
- Branch names: `type/description` (e.g. `fix/divergence-merge`, `feat/undo-manager`). Don't prefix with a username.
- When updating an existing branch after rewriting history, force-push directly — don't rebase-then-push.
- Commit messages follow recent `git log` style: lowercase `type: description (#N)` (`fix:`, `feat:`, `chore:`, `refactor:`, `perf:`).
- Run `npm run lint` before pushing.
