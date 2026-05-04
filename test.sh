#!/usr/bin/env bash
set -e

# my-brain test runner
# Unsets all API keys to prevent accidental external API calls during tests.

echo "Running tests without API keys..."

# Unset common AI provider API keys
unset ANTHROPIC_API_KEY
unset ANTHROPIC_OAUTH_TOKEN
unset OPENAI_API_KEY
unset GEMINI_API_KEY
unset GROQ_API_KEY
unset CEREBRAS_API_KEY
unset XAI_API_KEY
unset OPENROUTER_API_KEY
unset MISTRAL_API_KEY
unset DEEPSEEK_API_KEY
unset MINIMAX_API_KEY
unset HF_TOKEN
unset AI_GATEWAY_API_KEY
unset OPENCODE_API_KEY
unset COPILOT_GITHUB_TOKEN
unset GH_TOKEN
unset GITHUB_TOKEN
unset GOOGLE_APPLICATION_CREDENTIALS
unset GOOGLE_CLOUD_PROJECT
unset GCLOUD_PROJECT
unset AWS_PROFILE
unset AWS_ACCESS_KEY_ID
unset AWS_SECRET_ACCESS_KEY
unset AWS_SESSION_TOKEN
unset AWS_REGION
unset AWS_DEFAULT_REGION
unset FIREWORKS_API_KEY

# Run tests
bun test --coverage
