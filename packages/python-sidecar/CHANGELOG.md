# Changelog

## [Unreleased]

### Added

- Training pipeline: `run_lora.py` runner, `gen_fragments.py` and `generate_lora_data.py` data generators.
- LoRA adapter optimization: base model frozen before training, only `lora_a`/`lora_b` parameters trained (56 params, 2.5 MB vs 259 MB).
- Gemma 4 support: `_load_model_and_tokenizer()` with automatic `mlx-vlm` fallback for quantized Gemma 4 models (GPTQ-style biases/scales format).
- Initial release of the-brain -- pluggable cognitive OS for AI agents.

### Changed

- Default training model: `SmolLM2-135M-Instruct` → `gemma-4-e4b-it-4bit` (4B params, 5.22 GB).
- Training hyperparams: batch_size 2→4, max_seq_length 512→1024, iterations 50→200.
- Requires `mlx-vlm` as a dependency for Gemma 4 quantized model loading.

### Fixed

- `train.py` API adapted to match installed `mlx-lm` version: `linear_to_lora_layers(model, num_layers, config_dict)`, `TrainingArgs` without `learning_rate`, optimizer passed as `AdamW`.
- Tokenized dataset format: list of `(tokens_list, offset)` tuples instead of `mx.array`.
- LoRA weights saving: uses `tree_flatten(model.trainable_parameters())` for proper LoRA-only extraction.
- Gemma 4 LanguageModelOutput wrapped to return raw logits for mlx-lm training compatibility.

