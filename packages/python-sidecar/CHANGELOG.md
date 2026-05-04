# Changelog

## [Unreleased]

### Added

- Training pipeline: `run_lora.py` runner, `gen_fragments.py` and `generate_lora_data.py` data generators.
- LoRA adapter optimization: base model frozen before training, only `lora_a`/`lora_b` parameters trained (56 params, 2.5 MB vs 259 MB).
- Initial release of my-brain -- pluggable cognitive OS for AI agents.

### Fixed

- `train.py` API adapted to match installed `mlx-lm` version: `linear_to_lora_layers(model, num_layers, config_dict)`, `TrainingArgs` without `learning_rate`, optimizer passed as `AdamW`.
- Tokenized dataset format: list of `(tokens_list, offset)` tuples instead of `mx.array`.
- LoRA weights saving: uses `tree_flatten(model.trainable_parameters())` for proper LoRA-only extraction.

