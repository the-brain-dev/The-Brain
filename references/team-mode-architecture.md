# Team / Multi-User Mode — Architecture Proposal

> **Status:** Design proposal — implementation pending  
> **Date:** 2026-05-06  
> **Author:** Oskar Schachta

## Overview

the-brain currently operates in single-user mode. One Bearer token, one identity anchor per active project, no concept of who is pushing data. Remote mode already works (daemon on Linux, agents on Macs), but all agents share the same identity.

Team mode adds multi-user support: multiple developers or autonomous agents push interactions into shared project brains, with per-user identity, permissions, and audit trails.

## Use Cases

1. **Dev team on a shared codebase** — 5 developers using Cursor/Claude Code, all pushing to `project:frontend`. Each has their own preferences (tabs vs spaces, naming conventions) but team patterns (use Redux, avoid any) are learned globally.
2. **CI/CD agents alongside humans** — A bot agent runs tests and pushes failure patterns. Humans push their corrections. Brain learns from both.
3. **Research lab** — 3 researchers exploring the same domain with different AI assistants. Shared paper recommendations, project-specific vocabulary.

## Architecture

```
┌─ Linux Server ──────────────────────────────────────────────┐
│  the-brain daemon start --team                               │
│                                                              │
│  ┌─ Auth Gateway ────────────────────────────────────────┐  │
│  │  Per-user Bearer tokens (not one global mb_xxx)       │  │
│  │  Token → User identity → Project permissions           │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─ UserManager ─────────────────────────────────────────┐  │
│  │  User CRUD (add, remove, list, rotate-token)          │  │
│  │  Role: admin | contributor | observer                 │  │
│  │  Projects: ["cpv", "spm"] with per-project role       │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─ PermissionResolver ──────────────────────────────────┐  │
│  │  Can this user read/write/consolidate/train on       │  │
│  │  project X? Resolves user → project → role chain     │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─ Storage (extended) ──────────────────────────────────┐  │
│  │  memories: +user_id, +team_scope column               │  │
│  │  graph_nodes: +user_id, +shared flag                   │  │
│  │  users table: new                                      │  │
│  │  audit_log: new                                        │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  API :9420 (per-user auth)                                  │
│  MCP SSE :9422 (per-user auth)                              │
└──────────────────────────────────────────────────────────────┘
         ▲              ▲              ▲
         │              │              │
    ┌────┴──┐      ┌────┴──┐      ┌────┴──┐
    │ Oskar │      │ Anna  │      │ CI/CD │
    │ agent │      │ agent │      │ agent │
    │ token │      │ token │      │ token │
    └───────┘      └───────┘      └───────┘
```

## Data Model

### users table

```sql
CREATE TABLE users (
  id          TEXT PRIMARY KEY,          -- "user_<uuid>"
  name        TEXT NOT NULL UNIQUE,       -- "oskar"
  displayName TEXT,                       -- "Oskar Schachta"
  role        TEXT NOT NULL DEFAULT 'contributor',  -- admin|contributor|observer
  projects    TEXT NOT NULL DEFAULT '[]', -- JSON: ["cpv", "spm"]
  createdAt   INTEGER NOT NULL,
  lastActive  INTEGER
);
```

### auth_tokens table

```sql
CREATE TABLE auth_tokens (
  id         TEXT PRIMARY KEY,
  userId     TEXT NOT NULL REFERENCES users(id),
  token      TEXT NOT NULL UNIQUE,       -- "mb_<64-hex>" 
  label      TEXT,                        -- "MacBook Pro", "CI Server"
  createdAt  INTEGER NOT NULL,
  lastUsed   INTEGER,
  expiresAt  INTEGER,
  revoked    INTEGER NOT NULL DEFAULT 0  -- 0=active, 1=revoked
);
```

### audit_log table

```sql
CREATE TABLE audit_log (
  id        TEXT PRIMARY KEY,
  userId    TEXT NOT NULL REFERENCES users(id),
  action    TEXT NOT NULL,              -- "ingest_interaction", "consolidate", "train"
  project   TEXT,                        -- Which project scope
  detail    TEXT,                        -- Human-readable description
  timestamp INTEGER NOT NULL
);
```

### Extensions to existing tables

`memories` gets:
- `userId TEXT REFERENCES users(id)` — who generated this memory
- `scope TEXT NOT NULL DEFAULT 'user'` — `user` | `team`

`graph_nodes` gets:
- `userId TEXT REFERENCES users(id)` — who created this node
- `shared INTEGER NOT NULL DEFAULT 0` — promoted to team-level?

## Permission Model

### Roles

| Role | Read | Push interactions | Consolidate | Train | Manage users |
|------|------|-------------------|-------------|-------|--------------|
| admin | ✅ | ✅ | ✅ | ✅ | ✅ |
| contributor | ✅ | ✅ | ❌ | ❌ | ❌ |
| observer | ✅ | ❌ | ❌ | ❌ | ❌ |

Roles are **per-project**. A user can be `admin` on `cpv` and `contributor` on `spm`.

```json
{
  "users": {
    "oskar": {
      "role": "admin",
      "projects": {
        "cpv": "admin",
        "spm": "admin",
        "the-brain": "admin"
      }
    },
    "anna": {
      "role": "contributor",
      "projects": {
        "cpv": "contributor"
      }
    }
  }
}
```

## Context Injection Logic

When user Oskar opens a session on project CPV:

```
1. Fetch Oskar's per-user memories (scope=user, project=cpv)     → user context
2. Fetch team memories (scope=team, project=cpv)                   → team context
3. Fetch Oskar's identity anchor (stable self-vector)              → identity
4. Fetch global pattern overrides (user preferences cross-project) → global context

Inject order: identity → user context → team context → global patterns
```

### Identity Anchor (multi-user extension)

Each user gets their own identity anchor — a stable self-vector that:
- Tracks their coding style, naming preferences, tool choices
- Drift detection: "Oskar used to prefer tabs, now using spaces consistently for 2 weeks"
- Keeps per-user training state separate

## CLI Commands (new)

```bash
# User management (admin only)
the-brain user add --name oskar --project cpv --role admin
the-brain user add --name anna --project cpv --role contributor
the-brain user list [--project cpv]
the-brain user remove --name anna
the-brain user token --name oskar --label "MacBook Pro"      # Generate new API token
the-brain user token --revoke <token-id>                      # Revoke a token

# Global role (applies when no project override)
the-brain user set-role --name oskar --role admin --global
```

## API Endpoints (new)

```
POST   /api/users                    # Create user
GET    /api/users                    # List users
DELETE /api/users/:id               # Remove user
POST   /api/users/:id/tokens        # Generate new token
DELETE /api/users/:id/tokens/:tid   # Revoke token
GET    /api/users/:id/tokens        # List user's tokens

GET    /api/audit-log               # Query audit trail (?userId, ?project, ?limit)
```

All endpoints require admin role.

## Migration Path

### Phase 1: Core types + single-user backward compat (P0)
- Add User types, roles, schema to `@the-brain/core`
- Default: single admin user auto-created on `the-brain init`
- Existing `authToken` config continues working (mapped to default user)
- No breaking changes

### Phase 2: Multi-user auth gateway (P1)
- Plugin `@the-brain/plugin-auth-gateway` wraps API server
- New CLI commands: `the-brain user *`
- API: user CRUD endpoints
- Audit log (append-only)
- `the-brain init --team` creates team-ready config

### Phase 3: Team context + permissions (P2)
- `scope` column on memories — team vs user
- PermissionResolver enforces roles
- Team context injection (shared patterns)
- Per-user identity anchors

### Phase 4: Rich team features (P3)
- Web UI: team dashboard
- LDAP/OIDC integration (enterprise)
- Rate limiting per user
- Quotas: max projects per user
- Team-level training (shared LoRA adapters)

## Open Questions

1. **SSO vs token-based** — Start with token-based (simple, works now). SSO (Google/GitHub OAuth) as plugin later.
2. **Team memory weighting** — Should team patterns decay faster than personal patterns? Or the reverse?
3. **Conflict resolution** — If Anna pushes "use tabs" and Oskar pushes "use spaces" for the same project, how does brain resolve? (Likely: per-user scope, don't merge contradictory patterns)
4. **Global user** — Does the concept of a "global user" (cross-project identity) make sense? Yes — identity anchor is cross-project, project assignments are additive.
5. **Training isolation** — Per-user LoRA adapters? Team-wide adapter? Both? (Likely: both, composable)

## References

- [Remote Mode docs](/docs/integrations/remote-mode)
- [MCP Server docs](/docs/integrations/mcp-server)
- [Configuration schema](/docs/reference/config-schema)
