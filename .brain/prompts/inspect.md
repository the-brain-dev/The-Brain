---
description: Inspect memories, graph nodes, or plugin state in detail
argument-hint: "<what> [options]"
---
Inspect internal my-brain state with drill-down capability.

Usage: `my-brain inspect <what> [options]`

## Sub-commands

### `memories`
List and filter memories:
```
my-brain inspect memories [--layer instant|selection|deep] [--source cursor|claude] [--limit 20]
```
- Show: id, layer, source, timestamp, content preview (first 120 chars), surpriseScore
- Sort by timestamp descending

### `graph`
Explore the knowledge graph:
```
my-brain inspect graph [--node <id>] [--search <query>] [--type concept|correction|preference|pattern]
```
- Show: id, label, type, weight, connections count, content preview
- If `--node`: show detailed node + all connected nodes
- If `--search`: fuzzy search across label and content

### `sessions`
Show session history:
```
my-brain inspect sessions [--limit 20]
```
- Show: session ID, source, started/ended, interaction count

### `plugins`
Show detailed plugin info:
```
my-brain inspect plugins [--name <plugin>]
```
- Show: name, version, status, hooks, loadedAt, error (if any)

### `patterns`
Show cross-project patterns (global brain):
```
my-brain inspect patterns [--min-projects 2]
```
- Show: pattern hash, content, project count, first/last seen

## Output Format

### memories
```
id         layer       source    score   preview
abc123...  instant     cursor    0.15    "User asked about TypeScript const..."
def456...  selection   claude    0.72    "Fixed memory leak in harvester by..."
```

### graph
```
id         label              type        weight  connections
node001    "const vs let"     concept     0.85    3
node002    "harvester fix"    correction  0.92    5
```

## Hooks Fired

None — read-only operation.
