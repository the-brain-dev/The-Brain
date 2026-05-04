---
description: Show daemon health, stats, and current state
argument-hint: "[--watch]"
---
Display comprehensive daemon health and memory statistics.

## Process

1. **Check daemon status**:
   - Read PID file at `/tmp/my-brain-daemon.pid`
   - Verify process is running (`kill -0 <PID>`)
   - Calculate uptime from daemon start timestamp

2. **Database stats** (from current context and global):
   - Total memories across all layers
   - Per-layer breakdown: instant / selection / deep
   - Graph nodes count

3. **Plugin status**:
   - List all loaded plugins with status (active/inactive/error)
   - Show hooks each plugin subscribes to
   - Show any plugin errors

4. **Harvester activity**:
   - Last poll timestamp per harvester
   - New interactions since last poll
   - Total interactions harvested

5. **Consolidation history**:
   - Last consolidation timestamp
   - Promoted/discarded counts
   - SPM promote rate (%)

6. **Training status** (if MLX enabled):
   - Last training timestamp
   - Adapter size and location
   - Training loss history

7. **Cross-project context**:
   - Active context (global or project name)
   - Registered projects with sizes
   - Cross-project promotion count

8. **Memory growth rate**:
   - Memories/day over last 7 days
   - Projected DB size

## Output Format

```
Status:           🟢 RUNNING (or 🔴 STOPPED / 🟡 STARTING)
Uptime:           <duration>
Total memories:   <N>
Graph nodes:      <N>
By layer:         instant <N> | selection <N> | deep <N>
LoRA adapter:     <size> MB (<time> ago)
Wiki:             <N> pages
Projects:         <name> (<size> KB) | ...
Memory growth:    <N>/day

Plugins:
  <name>    active     hooks: <hook1>, <hook2>, ...
  <name>    error      <error message>

Harvesters:
  cursor    last poll: <time>    new: <N>
  claude    last poll: <time>    new: <N>

Consolidation:
  last:       <time>
  promoted:   <N>
  discarded:  <N>
  SPM rate:   <X>%
```

If `--watch` is specified: refresh every 2 seconds (like `htop`).

## Hooks Fired

None — read-only operation.
