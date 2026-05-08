# Changelog

## [Unreleased]

### Added

- Initial release of the-brain -- pluggable cognitive OS for AI agents.

### Changed

- Default model: `SmolLM2-135M-Instruct` → `gemma-4-e4b-it-4bit` (4B params).
- Training hyperparams: batchSize 2→4, maxSeqLength 512→1024, iterations 50→200.
- Spawn command includes `--with mlx-vlm` for Gemma 4 quantized model loading.

