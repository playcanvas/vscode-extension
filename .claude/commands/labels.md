---
name: labels
description: Detect which repo labels apply to the current branch based on changed files
user_invocable: true
---

# Detect PR/Issue Labels

## 1. Gather data (parallel)

- `git diff main...HEAD --name-only` — changed files
- `GIT_SSL_NO_VERIFY=1 GH_HOST=github.sc-corp.net GH_REPO=Snapchat/playcanvas-monorepo gh label list --limit 200 --json name` — available labels

## 2. Map files to labels

Label applies if **any** changed file matches. Only use labels that exist in the fetched label list.

### Mapping rules

- `service:<name>` — top-level `<name>/` dir matches service label (e.g. `assets-server/` → `service:assets-server`)
- `job:<name>` — `pipeline/jobs/<name>/` dir matches job label
- `cron:<name>` — `event-jobs/jobs/<name>.js` matches cron label
- `suite:editor` — `test-suites/editor/` or `submodules/editor/`
- `flag:ingress-rules` — `kubernetes/setup-ingress.sh` or `kubernetes/templates/**/ingress-rule*.yaml`
- `flag:skip-tests` — never auto-apply
- `*:all` variants — only when change truly affects all items in category (e.g. universal shared module)

### Shared modules require caller tracing

- `pipeline/modules/` files are NOT jobs. Trace `require`/`import` chains to find which `pipeline/jobs/*/` consume them. Label only those jobs.
- `event-jobs/modules/` — same: trace to specific `event-jobs/jobs/*.js` callers.
- `shared-libs/` — contains DB schemas, utilities used across services and jobs. Trace which services/jobs `require`/`import` the changed file and label each one. Schema changes can affect any consumer.
- Do NOT use `job:all`/`cron:all`/`service:all` unless module is truly used by every item in that category (e.g. `task-handler.js`, `error.js`).

### Infra (no label, just note)

- `kubernetes/` (non-ingress), `snapci/`, `snapc_configs/` — mention in output

## 3. Output

1. **Changed files** — grouped by area
2. **Labels** — comma-separated list
3. **Reasoning** — brief explanation for shared-module tracing

No speculative labels. Only confirmed dependency chains.
