# AGENTS.md - PlayCanvas VS Code Extension

VS Code extension for real-time collaborative editing of PlayCanvas assets. Syncs bidirectionally with PlayCanvas Editor via ShareDB (Operational Transform).

## Directory Structure

```
src/
├── extension.ts          # entry point, commands, orchestration
├── project-manager.ts    # virtual file system, asset state, collisions
├── disk.ts               # file system sync (ShareDB <-> VS Code)
├── auth.ts               # OAuth authentication
├── config.ts             # environment constants
├── log.ts                # logging utility
├── notification.ts       # progress/simple notifications
├── connections/
│   ├── sharedb.ts        # OT collaborative editing (WebSocket)
│   ├── messenger.ts      # project events (WebSocket)
│   ├── relay.ts          # presence/collaboration (WebSocket)
│   └── rest.ts           # REST API client
├── handlers/
│   └── uri-handler.ts    # deep linking from Editor
├── providers/
│   └── collab-provider.ts # collaborators tree view
├── utils/
│   ├── linker.ts         # Linker pattern base class
│   ├── signal.ts         # reactive state (signal/computed/effect)
│   ├── event-emitter.ts  # type-safe event emitter
│   ├── mutex.ts          # path-based mutex for atomic ops
│   ├── debouncer.ts      # key-based debouncing
│   ├── bimap.ts          # bidirectional map
│   ├── buffer.ts         # text/buffer conversion
│   ├── deferred.ts       # deferred promise pattern
│   └── utils.ts          # hash, tryCatch, guard, vscode2sharedb, etc.
├── typings/
│   ├── event-map.d.ts    # event type definitions
│   ├── models.d.ts       # Asset, Project, Branch, User types
│   ├── sharedb.d.ts      # ShareDB operation types
│   └── ot-text.d.ts      # ot-text module declaration
└── test/
    ├── mocks/            # mock implementations for testing
    └── suite/            # test suites
plugin/                   # TypeScript language server plugin
scripts/                  # build & codegen scripts
```

## Key Patterns

- **Linker Pattern**: Components extend `Linker<T>` with `link()`/`unlink()` lifecycle
- **Signal Pattern**: Reactive state via `signal()`, `computed()`, `effect()`
- **Event-Driven**: Type-safe `EventEmitter` for component communication
- **Mutex**: Path-based mutex (`_writeMutex`, `_readMutex`) to serialize related operations
- **Debouncer**: Key-based debouncing for batching disk writes (50ms default)
- **Atomic OT Ops**: Single replace ops `[offset, text, { d: len }]` instead of separate delete+insert
- **Minimal Diff**: Prefix/suffix matching in `projectManager.write()` to minimize op size
- **Echo Mechanism**: Hash-based echo map to prevent feedback loops on disk writes
- **Naming**: Private members prefixed with `_`, files in kebab-case

## Data Flow

```
Remote: ShareDB → ProjectManager → Disk → VS Code
Local:  VS Code → Disk → ProjectManager → ShareDB
```

### Sync Architecture

- **Local edits (open files)**: `vscode2sharedb()` converts `contentChanges` to atomic ShareDB ops with offset adjustment for batched changes, submitted directly to ShareDB for real-time collaboration
- **Remote edits (open files)**: `sharedb2vscode()` converts ShareDB ops to VS Code `TextEdit[]`, applied under per-URI lock with post-lock reconciliation for keystrokes dropped during the lock window
- **Closed file writes**: `projectManager.write()` computes minimal diff via prefix/suffix matching and submits a single atomic op
- **Disk sync**: Debounced writes with echo hash set at write time to prevent re-processing by the file watcher

## Commands

- `playcanvas.login` - Authenticate
- `playcanvas.openProject` - Open project
- `playcanvas.reloadProject` - Reload project
- `playcanvas.switchBranch` - Switch branch
- `playcanvas.showPathCollisions` - Show path collisions

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

Note: `npm test` requires a VS Code instance and network access; use `npm run lint` and `npm run pretest` to validate changes locally.
