# MLX Local Training

the-brain supports local LoRA fine-tuning on Apple Silicon Macs using MLX.
Training runs as a scheduled background job, typically while you sleep.

## Prerequisites

- macOS with Apple Silicon (M1/M2/M3/M4)
- `uv` installed: `curl -LsSf https://astral.sh/uv/install.sh | sh`
- Python 3.10+

## Setup

```bash
# Install MLX and dependencies
cd packages/python-sidecar
uv sync

# Verify installation
uv run python -c "import mlx.core; print(mlx.core.metal.is_available())"
# Should output: True
```

## Training Flow

1. **Data Collection**: Harvesters collect interactions from Cursor, Claude Code, etc.
2. **Curation**: SPM Curator filters interactions, keeping only "surprising" ones.
3. **Dataset Building**: Curated interactions are converted to instruction-format JSONL.
4. **LoRA Training**: MLX fine-tunes a base model on the curated dataset.
5. **Identity Anchor**: Prevents catastrophic forgetting by maintaining a stable self-vector.

## Training Output

```
~/.the-brain/
├── lora-adapters/
│   ├── adapter_2026-05-03.safetensors    # Weekly snapshot
│   ├── adapter_latest.safetensors        # Latest adapter
│   └── training_log.jsonl                # Loss curves + metrics
└── datasets/
    └── curated_2026-05-03.jsonl          # Training data
```

## Configuration

```yaml
deep:
  plugin: local-mlx
  schedule: "0 2 * * 0"     # Sunday at 2 AM
  baseModel: mlx-community/Llama-3.2-3B-Instruct-4bit
  loraRank: 16
  numEpochs: 3
  batchSize: 4
  learningRate: 1e-4
  outputDir: ~/.the-brain/lora-adapters
```

## Manual Training

```bash
# Force training immediately
the-brain consolidate --now

# Or run the Python script directly
cd packages/python-sidecar
uv run python train_lora.py \
  --data ~/.the-brain/datasets/curated_latest.jsonl \
  --model mlx-community/Llama-3.2-3B-Instruct-4bit \
  --output ~/.the-brain/lora-adapters \
  --rank 16 \
  --epochs 3

## Using with Local Models

Load the trained adapter with any MLX-compatible inference server:

```bash
# With llama.cpp server
mlx_lm.server --model mlx-community/Llama-3.2-3B-Instruct-4bit \
  --adapter-path ~/.the-brain/lora-adapters/adapter_latest.safetensors
```

## Disabling Training

If you prefer using cloud API models without local training:

```yaml
# In ~/.the-brain/config.yaml
deep:
  plugin: none  # Disable Layer 3 entirely
```

Or set the environment variable:
```bash
export NO_MLX=1
```

With Layer 3 disabled, memory stays in Layers 1-2 using Graph Memory + SPM Curation,
which work with any provider (OpenAI, Anthropic, etc.).
