# Configuration

the-brain is configured via `~/.the-brain/config.yaml`.

## Full Configuration Reference

```yaml
# Database path (default: ~/.the-brain/brain.db)
database:
  path: ~/.the-brain/brain.db

# Daemon settings
daemon:
  # Polling interval in seconds for harvesters
  pollInterval: 60
  # Maximum memory entries before triggering curation
  maxEntriesBeforeCuration: 1000

# Layer 1: Instant Memory
instant:
  # Plugin name (must be registered)
  plugin: graph-memory
  # Max graph nodes in working memory
  maxNodes: 1000
  # TTL for graph nodes (seconds)
  nodeTtl: 3600

# Layer 2: Selection / Curation
selection:
  plugin: spm-curator
  # Surprise threshold (Z-score)
  surpriseThreshold: 2.0
  # Minimum sequence length for n-gram analysis
  minSequenceLength: 3
  # Number of top items to promote per batch
  batchSize: 50

# Layer 3: Deep / Training
deep:
  plugin: local-mlx
  # Training schedule (cron expression)
  schedule: "0 2 * * 0"  # Sunday at 2 AM
  # Base model for LoRA training
  baseModel: mlx-community/Llama-3.2-3B-Instruct-4bit
  # LoRA rank
  loraRank: 16
  # Output directory for LoRA adapters
  outputDir: ~/.the-brain/lora-adapters

# Plugins to load
plugins:
  - "@the-brain/plugin-graph-memory"
  - "@the-brain/plugin-spm-curator"
  - "@the-brain/plugin-harvester-cursor"
  - "@the-brain/plugin-harvester-claude"
  - "@the-brain/plugin-identity-anchor"
  - "@the-brain/plugin-auto-wiki"
  - "@the-brain/trainer-local-mlx"

# Output plugins
outputs:
  auto-wiki:
    enabled: true
    schedule: "0 9 * * 0"  # Sunday at 9 AM
    outputDir: ~/.the-brain/wiki
    port: 3000
```

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `THE_BRAIN_HOME` | Override config/data directory | `~/.the-brain` |
| `THE_BRAIN_CONFIG` | Override config file path | `~/.the-brain/config.yaml` |
| `THE_BRAIN_LOG_LEVEL` | Log level (debug, info, warn, error) | `info` |
| `NO_MLX` | Disable MLX Python sidecar | unset |

## Plugin Loading

Plugins can be loaded from multiple sources:

```yaml
plugins:
  # npm package (default — looks in workspace)
  - "@the-brain/plugin-graph-memory"

  # Local path
  - "./my-custom-plugin"

  # GitHub URL
  - "github:user/the-brain-plugin"
```

## CLI Equivalents

Some settings can be overridden via CLI:

```bash
the-brain daemon start --poll-interval 30
the-brain consolidate --now --batch-size 100
the-brain switch-context --project my-app
```
