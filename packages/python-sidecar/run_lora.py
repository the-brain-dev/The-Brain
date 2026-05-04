#!/usr/bin/env python3
"""Runner that reads fragments from file and calls train.py functions."""
import json
import sys
import os

# Add to path to import train.py
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from train import check_mlx_available, prepare_training_data, train_lora

# Read fragments from the generated file
with open('/Users/oskarschachta/.my-brain/lora-checkpoints/lora_fragments.json') as f:
    fragments = json.load(f)

print(f"[my-brain] Loaded {len(fragments)} training fragments")

if not check_mlx_available():
    print("[my-brain] ERROR: MLX not available!")
    sys.exit(1)

model_path = "mlx-community/SmolLM2-135M-Instruct"
output_dir = "/Users/oskarschachta/.my-brain/lora-checkpoints"
learning_rate = 1e-4
lora_rank = 16
lora_alpha = 32
batch_size = 2
max_seq_length = 512
iterations = 50

# Step 1: Prepare data
sample_count, data_path = prepare_training_data(fragments, output_dir)
print(f"[my-brain] Prepared {sample_count} training samples -> {data_path}")

if sample_count == 0:
    print("[my-brain] No valid samples, aborting")
    sys.exit(1)

# Step 2: Run training
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

print(f"\n[my-brain] ✅ Training successful!")
print(f"[my-brain]   Samples:    {config['samples']}")
print(f"[my-brain]   Iterations: {config['iterations']}")
print(f"[my-brain]   Duration:   {config['duration']:.1f}s")
print(f"[my-brain]   Output:     {output_dir}/")
print(f"[my-brain]   Model:      {model_path}")
