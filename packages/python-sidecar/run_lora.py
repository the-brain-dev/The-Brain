#!/usr/bin/env python3
"""Runner that reads fragments from file and calls train.py functions."""
import json
import sys
import os

# Add to path to import train.py
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from train import check_mlx_available, prepare_training_data, train_lora

# Resolve paths relative to ~/.the-brain/
brain_dir = os.path.expanduser("~/.the-brain")
fragments_path = os.path.join(brain_dir, "lora-checkpoints", "lora_fragments.json")
output_dir = os.path.join(brain_dir, "lora-checkpoints")

# Allow override via command-line args
# Usage: python run_lora.py [fragments_path] [output_dir]
if len(sys.argv) > 1:
    fragments_path = sys.argv[1]
if len(sys.argv) > 2:
    output_dir = sys.argv[2]

# Read fragments from the file
try:
    with open(fragments_path, encoding="utf-8") as f:
        fragments = json.load(f)
except FileNotFoundError:
    print(f"[the-brain] ERROR: Fragments file not found: {fragments_path}", file=sys.stderr)
    sys.exit(1)
except (json.JSONDecodeError, OSError) as e:
    print(f"[the-brain] ERROR: Failed to read fragments: {e}", file=sys.stderr)
    sys.exit(1)

print(f"[the-brain] Loaded {len(fragments)} training fragments")

if not check_mlx_available():
    print("[the-brain] ERROR: MLX not available!")
    sys.exit(1)

model_path = "mlx-community/SmolLM2-135M-Instruct"
learning_rate = 1e-4
lora_rank = 16
lora_alpha = 32
batch_size = 2
max_seq_length = 512
iterations = 50

# Step 1: Prepare data
try:
    sample_count, data_path = prepare_training_data(fragments, output_dir)
except Exception as e:
    print(f"[the-brain] ERROR: Data preparation failed: {e}", file=sys.stderr)
    sys.exit(1)

print(f"[the-brain] Prepared {sample_count} training samples -> {data_path}")

if sample_count == 0:
    print("[the-brain] No valid samples, aborting")
    sys.exit(1)

# Step 2: Run training
try:
    config = train_lora(
        model_path=model_path,
        data_path=data_path,
        output_dir=output_dir,
        learning_rate=learning_rate,
        lora_rank=lora_rank,
        lora_alpha=lora_alpha,
        batch_size=batch_size,
        max_seq_length=max_seq_length,
        iterations=iterations,
    )
except Exception as e:
    print(f"[the-brain] ERROR: Training failed: {e}", file=sys.stderr)
    sys.exit(1)

print(f"\n[the-brain] ✅ Training successful!")
print(f"[the-brain]   Samples:    {config['samples']}")
print(f"[the-brain]   Iterations: {config['iterations']}")
print(f"[the-brain]   Duration:   {config['duration']:.1f}s")
print(f"[the-brain]   Output:     {output_dir}/")
print(f"[the-brain]   Model:      {model_path}")
