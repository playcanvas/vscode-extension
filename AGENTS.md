# AGENTS.md - PlayCanvas VS Code Extension

VS Code extension for real-time collaborative editing of PlayCanvas assets. Syncs bidirectionally with PlayCanvas Editor via ShareDB (Operational Transform).

## Directory Structure

```
src/
├── extension.ts        # Entry point, commands, orchestration
├── project-manager.ts  # Virtual file system, asset state, collisions
├── disk.ts             # File system sync (ShareDB <-> VS Code)
├── auth.ts             # OAuth authentication
├── config.ts           # Environment constants
├── connections/        # Backend connections
│   ├── sharedb.ts      # OT collaborative editing (WebSocket)
│   ├── messenger.ts    # Project events (WebSocket)
│   ├── relay.ts        # Presence/collaboration (WebSocket)
│   └── rest.ts         # REST API client
├── handlers/
│   └── uri-handler.ts  # Deep linking from Editor
├── providers/
│   └── collab-provider.ts  # Collaborators tree view
├── utils/              # Utilities (signal, mutex, event-emitter, etc.)
├── typings/            # TypeScript type definitions
└── test/               # Tests and mocks
plugin/                 # TypeScript language server plugin
```

## Key Patterns

- **Linker Pattern**: Components extend `Linker<T>` with `link()`/`unlink()` lifecycle
- **Signal Pattern**: Reactive state via `signal()`, `computed()`, `effect()`
- **Event-Driven**: Type-safe `EventEmitter` for component communication
- **Naming**: Private members prefixed with `_`, files in kebab-case

## Data Flow

```
Remote: ShareDB → ProjectManager → Disk → VS Code
Local:  VS Code → Disk → ProjectManager → ShareDB
```

## Commands

- `playcanvas.login` - Authenticate
- `playcanvas.openProject` - Open project
- `playcanvas.reloadProject` - Reload project
- `playcanvas.switchBranch` - Switch branch
- `playcanvas.showPathCollisions` - Show path collisions

## Build & Test

```bash
npm run build    # Production build
npm run compile  # TypeScript compile
npm test         # Run tests
npm run lint     # Lint check
```
