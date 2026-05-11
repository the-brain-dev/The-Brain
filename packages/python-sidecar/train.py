#!/usr/bin/env python3
"""
the-brain MLX Sidecar — LoRA fine-tuning on Apple Silicon.

Called by @the-brain/trainer-local-mlx to consolidate curated memories
into model weights using Apple's MLX framework.

Usage:
  uv run --with mlx-lm --with mlx-vlm python3 train.py \
    --model-path mlx-community/Llama-3.2-1B-Instruct-4bit \
    --lora-output-dir ~/.the-brain/lora-checkpoints \
    --learning-rate 1e-4 \
    --lora-rank 16 \
    --iterations 200 \
    --data '[{"text": "example training sample"}]'
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Optional


def check_mlx_available() -> bool:
    """Check if MLX is available on this system."""
    try:
        import mlx.core as mx
        return True
    except ImportError:
        return False


def prepare_training_data(fragments: list[dict], output_path: str) -> tuple[int, str]:
    """
    Convert memory fragments into training format.
    
    Formats supported:
    - Direct text (raw conversation fragments)
    - Instruction-response pairs with metadata
    
    Returns (sample_count, data_path)
    """
    samples = []
    
    for frag in fragments:
        text = frag.get("text", "")
        metadata = frag.get("metadata", {})
        
        if not text.strip():
            continue
        
        # Format as instruction-tuning sample
        # Use metadata to construct a meaningful instruction
        source = metadata.get("source", "user")
        layer = metadata.get("layer", "unknown")
        is_correction = metadata.get("type") == "correction"
        is_preference = metadata.get("type") == "preference"
        
        if is_correction:
            instruction = "The user corrected a previous response. Learn from this correction."
        elif is_preference:
            instruction = "The user expressed a coding or style preference."
        else:
            instruction = f"Interaction from {source} (layer: {layer})"
        
        samples.append({
            "instruction": instruction,
            "response": text[:4096],  # Truncate long responses
        })
    
    # Write as JSONL
    data_path = Path(output_path) / "training_data.jsonl"
    data_path.parent.mkdir(parents=True, exist_ok=True)
    
    with open(data_path, "w", encoding="utf-8") as f:
        for sample in samples:
            f.write(json.dumps(sample) + "\n")
    
    return len(samples), str(data_path)


def _load_model_and_tokenizer(model_path: str):
    """
    Load model and tokenizer, with fallback for Gemma 4 quantized models.
    
    mlx-lm 0.31.3 cannot load some 4-bit Gemma 4 models due to GPTQ-style
    quantization format (biases/scales). mlx-vlm handles them correctly.
    """
    import mlx_lm
    
    # Try mlx-lm first (works for most models)
    try:
        print(f"[MLX] Loading model via mlx-lm: {model_path}")
        model, tokenizer = mlx_lm.load(model_path)
        print(f"[MLX] Loaded: {type(model).__name__}")
        return model, tokenizer, False  # is_vlm=False
    except ValueError as e:
        if "Missing parameters" not in str(e) and "biases" not in str(e):
            raise
        print(f"[MLX] mlx-lm failed (quantization format), trying mlx-vlm...")
    
    # Fallback: use mlx-vlm for Gemma 4 / quantized VLM models
    try:
        from mlx_vlm import load as vlm_load
        model, processor = vlm_load(model_path)
        # Extract language_model for LoRA training
        if hasattr(model, "language_model"):
            lm = model.language_model
            tokenizer = processor.tokenizer if hasattr(processor, "tokenizer") else processor
            print(f"[MLX] Loaded via mlx-vlm: {type(lm).__name__} (inner: {type(lm.model).__name__})")
            
            # Wrap __call__ to return raw logits (not LanguageModelOutput)
            # mlx-lm training loss expects raw tensor, not dataclass.
            # Must patch on the class — MLX Module.__call__ is special.
            _orig_call = lm.__class__.__call__
            def _logits_call(self, *args, **kwargs):
                output = _orig_call(self, *args, **kwargs)
                return output.logits if hasattr(output, "logits") else output
            lm.__class__.__call__ = _logits_call
            
            return lm, tokenizer, True  # is_vlm=True
        else:
            tokenizer = processor
            print(f"[MLX] Loaded via mlx-vlm: {type(model).__name__}")
            return model, tokenizer, True
    except ImportError:
        raise RuntimeError(
            "Model requires mlx-vlm to load. Install it with:\n"
            "  uv run --with mlx-vlm python3 ..."
        )


def train_lora(
    model_path: str,
    data_path: str,
    output_dir: str,
    learning_rate: float = 1e-4,
    lora_rank: int = 16,
    lora_alpha: int = 32,
    batch_size: int = 4,
    max_seq_length: int = 2048,
    iterations: int = 200,
) -> dict:
    """
    Run LoRA fine-tuning using MLX-LM.
    
    Supports Gemma 4 quantized models via mlx-vlm fallback.
    
    Returns training metrics dict.
    """
    import mlx.core as mx
    import mlx.optimizers as optim
    from mlx_lm.tuner import train, TrainingArgs
    from mlx_lm.tuner.utils import linear_to_lora_layers
    
    model, tokenizer, is_vlm = _load_model_and_tokenizer(model_path)
    
    print(f"[MLX] Preparing LoRA layers (rank={lora_rank}, alpha={lora_alpha})")
    lora_config = {
        "rank": lora_rank,
        "scale": lora_alpha,
        "dropout": 0.0,
    }
    num_layers_to_convert = 4  # Convert last 4 layers to LoRA
    linear_to_lora_layers(model, num_layers_to_convert, lora_config)
    
    # Freeze original weights, only train LoRA parameters
    print("[MLX] Freezing base model, enabling LoRA training only...")
    model.freeze()
    model.unfreeze(keys=["lora_a", "lora_b"])
    trainable_count = len(list(model.trainable_parameters()))
    print(f"[MLX] Trainable parameters: {trainable_count} (LoRA only)")
    
    print(f"[MLX] Loading training data from: {data_path}")
    
    # Load and tokenize training data
    with open(data_path, encoding="utf-8") as f:
        train_data = [json.loads(line) for line in f if line.strip()]
    
    print(f"[MLX] Training samples: {len(train_data)}")
    
    # Tokenize
    print(f"[MLX] Tokenizing {len(train_data)} samples...")
    train_tokens = []
    for sample in train_data:
        text = f"Instruction: {sample['instruction']}\n\nResponse: {sample['response']}"
        tokens = tokenizer.encode(text)
        train_tokens.append((tokens, 0))  # (token_ids, offset) tuple format
    
    print(f"[MLX] Tokenized: {[len(t[0]) for t in train_tokens]}")
    
    # Create optimizer
    optimizer = optim.AdamW(learning_rate=learning_rate)
    
    # Training args
    args = TrainingArgs(
        batch_size=batch_size,
        iters=iterations,
        max_seq_length=max_seq_length,
        steps_per_report=10,
        steps_per_save=50,
        adapter_file="adapters.safetensors",
    )
    
    print(f"[MLX] Starting LoRA training ({iterations} iterations)...")
    start_time = time.time()
    
    # Train
    train(
        model=model,
        optimizer=optimizer,
        train_dataset=train_tokens,
        val_dataset=None,
        args=args,
    )
    
    duration = time.time() - start_time
    print(f"[MLX] Training complete in {duration:.1f}s")
    
    # Save LoRA weights only (not full model)
    os.makedirs(output_dir, exist_ok=True)
    lora_adapter_path = os.path.join(output_dir, "adapter.safetensors")
    
    # Use tree_flatten to get properly flattened trainable params
    from mlx.utils import tree_flatten
    lora_weights = dict(tree_flatten(model.trainable_parameters()))
    
    if lora_weights:
        mx.save_safetensors(lora_adapter_path, lora_weights)
        lora_size_mb = sum(v.nbytes for v in lora_weights.values()) / 1024 / 1024
        print(f"[MLX] LoRA adapter saved to: {lora_adapter_path} ({lora_size_mb:.1f} MB, {len(lora_weights)} params)")
    else:
        print(f"[MLX] WARNING: No LoRA weights found, saving full model")
        model.save_weights(lora_adapter_path)
    
    # Save config
    config = {
        "model_path": model_path,
        "lora_rank": lora_rank,
        "lora_alpha": lora_alpha,
        "learning_rate": learning_rate,
        "iterations": iterations,
        "samples": len(train_data),
        "duration": duration,
        "timestamp": time.time(),
    }
    config_path = os.path.join(output_dir, "training_config.json")
    with open(config_path, "w") as f:
        json.dump(config, f, indent=2)
    
    return config


def main():
    parser = argparse.ArgumentParser(
        description="the-brain MLX LoRA Trainer Sidecar"
    )
    parser.add_argument("--model-path", required=True, help="HuggingFace model or local path")
    parser.add_argument("--lora-output-dir", required=True, help="Output directory for LoRA adapter")
    parser.add_argument("--learning-rate", type=float, default=1e-4)
    parser.add_argument("--lora-rank", type=int, default=16)
    parser.add_argument("--lora-alpha", type=int, default=32)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--max-seq-length", type=int, default=2048)
    parser.add_argument("--iterations", type=int, default=200)
    parser.add_argument("--data", required=True, help="JSON array of training fragments OR path to JSON file")
    
    args = parser.parse_args()
    
    # Check MLX availability
    if not check_mlx_available():
        print("[MLX] WARNING: MLX not available. Running in simulation mode.")
        print("[MLX] Training data would be processed, but no actual training occurs.")
        
        # Simulation mode — just parse and report
        try:
            fragments = json.loads(args.data)
        except json.JSONDecodeError as e:
            print(f"[MLX] ERROR: Invalid JSON data: {e}", file=sys.stderr)
            sys.exit(1)
        print(f"[MLX] Would train on {len(fragments)} fragments")
        print(f"[MLX] Model: {args.model_path}")
        print(f"[MLX] Output: {args.lora_output_dir}")
        
        # Write a simulation config
        os.makedirs(args.lora_output_dir, exist_ok=True)
        sim_config = {
            "simulated": True,
            "model_path": args.model_path,
            "samples": len(fragments),
            "warning": "MLX not installed. Install with: pip install mlx mlx-lm",
        }
        config_path = os.path.join(args.lora_output_dir, "training_config.json")
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(sim_config, f, indent=2)
        
        return
    
    # Real training mode
    # Support both inline JSON and file paths
    if args.data.startswith("[") or args.data.startswith("{"):
        fragments = json.loads(args.data)
    else:
        # Treat as file path
        data_file = Path(args.data)
        if data_file.exists():
            with open(data_file, encoding="utf-8") as f:
                fragments = json.load(f)
        else:
            print(f"[MLX] ERROR: Data not found at {args.data} and not valid JSON", file=sys.stderr)
            sys.exit(1)
    
    if not fragments:
        print("[MLX] No training fragments provided, skipping")
        return
    
    # Prepare data
    sample_count, data_path = prepare_training_data(fragments, args.lora_output_dir)
    
    if sample_count == 0:
        print("[MLX] No valid training samples after filtering")
        return
    
    # Run training
    try:
        config = train_lora(
            model_path=args.model_path,
            data_path=data_path,
            output_dir=args.lora_output_dir,
            learning_rate=args.learning_rate,
            lora_rank=args.lora_rank,
            lora_alpha=args.lora_alpha,
            batch_size=args.batch_size,
            max_seq_length=args.max_seq_length,
            iterations=args.iterations,
        )
        
        print(f"\n[MLX] ✅ Training successful!")
        print(f"[MLX] Samples: {config['samples']}")
        print(f"[MLX] Duration: {config['duration']:.1f}s")
        print(f"[MLX] Output: {args.lora_output_dir}")
        
    except Exception as e:
        print(f"[MLX] ❌ Training failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
