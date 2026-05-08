#!/usr/bin/env bash
#
# run-cycle.sh — the-brain self-evolution harness orchestrator
#
# Actions:
#   run    — execute one cycle (default)    ./run-cycle.sh --mode quick-fix
#   review — interactive HITL batch review  ./run-cycle.sh --review [batch-id]
#   submit — create PR from batch           ./run-cycle.sh --submit [batch-id]
#   daemon — continuous loop                ./run-cycle.sh --daemon --mode quick-fix
#
# Usage:
#   ./run-cycle.sh [action] [options]
#   ./run-cycle.sh --run --mode quick-fix    (explicit run)
#   ./run-cycle.sh --mode quick-fix          (implicit run)
#   ./run-cycle.sh --review                 (latest open batch)
#   ./run-cycle.sh --review 3               (specific batch)
#   ./run-cycle.sh --submit 3               (auto PR)
#   ./run-cycle.sh --daemon --mode quick-fix --agent claude
#
# Environment:
#   THE_BRAIN_AGENT               — coding agent (default: claude)
#   THE_BRAIN_MAX_CYCLES          — cycles per batch (default: 5)
#   THE_BRAIN_DAEMON_SLEEP        — daemon sleep seconds (default: 300)

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
EVOLUTION_DIR="$SCRIPT_DIR"
DB_PATH="$EVOLUTION_DIR/evolution.db"

AGENT="${THE_BRAIN_AGENT:-claude}"
MAX_CYCLES="${THE_BRAIN_MAX_CYCLES_PER_BATCH:-5}"
DAEMON_SLEEP="${THE_BRAIN_DAEMON_SLEEP:-300}"

ACTION="run"          # run | review | submit | daemon
MODE=""               # quick-fix | coverage | brain-bench | deep-refactor | self-evolve
DRY_RUN=false
BATCH_ID=""           # for review/submit — if empty, uses latest
CYCLE_NUM=0
BRANCH_NAME=""
NON_INTERACTIVE=false  # skip confirmations (for daemon mode)

# ── Help ───────────────────────────────────────────────────────────────────────

show_help() {
  cat <<EOF
run-cycle.sh — the-brain self-evolution harness

Actions:
  run        Execute one self-evolution cycle (default)
  review     Interactive HITL batch review — accept/reject each cycle
  submit     Auto-create PR from a completed batch
  daemon     Continuous loop: run cycles → batch full → auto-PR → wait → repeat

Usage:
  ./run-cycle.sh --mode <mode>                   # run one cycle
  ./run-cycle.sh --run --mode <mode>             # explicit run
  ./run-cycle.sh --review [batch-id]             # interactive review
  ./run-cycle.sh --submit [batch-id]             # create PR
  ./run-cycle.sh --daemon --mode <mode>          # continuous loop
  ./run-cycle.sh --dry-run --mode <mode>         # preview without running

Options:
  --mode <mode>      quick-fix | coverage | brain-bench | deep-refactor | self-evolve
  --agent <agent>    claude (default) | codex | hermes
  --dry-run          Show prompt without invoking agent
  --yes / -y         Skip confirmation prompts (daemon mode)
  --help / -h        This message

Environment:
  THE_BRAIN_AGENT                default agent (claude)
  THE_BRAIN_MAX_CYCLES_PER_BATCH  cycles before HITL (5)
  THE_BRAIN_DAEMON_SLEEP          daemon wait between runs (300s)

Examples:
  ./run-cycle.sh --mode quick-fix
  ./run-cycle.sh --mode coverage --agent codex
  ./run-cycle.sh --review              # review latest batch
  ./run-cycle.sh --submit 3            # PR from batch #3
  ./run-cycle.sh --daemon --mode quick-fix -y  # unattended loop
EOF
}

# ── Parse Args ────────────────────────────────────────────────────────────────

# First pass: detect action
for arg in "$@"; do
  case $arg in
    --run)        ACTION="run" ;;
    --review)     ACTION="review" ;;
    --submit)     ACTION="submit" ;;
    --daemon)     ACTION="daemon" ;;
  esac
done

# Second pass: extract options
while [[ $# -gt 0 ]]; do
  case $1 in
    --run|--review|--submit|--daemon)
      # Already handled — if --review or --submit followed by a number, treat as batch id
      if [[ "$ACTION" == "review" || "$ACTION" == "submit" ]]; then
        shift
        if [[ $# -gt 0 && "$1" =~ ^[0-9]+$ ]]; then
          BATCH_ID="$1"; shift
        fi
        continue
      fi
      shift
      ;;
    --mode)      MODE="$2"; shift 2 ;;
    --agent)     AGENT="$2"; shift 2 ;;
    --dry-run)   DRY_RUN=true; shift ;;
    --yes|-y)    NON_INTERACTIVE=true; shift ;;
    --help|-h)   show_help; exit 0 ;;
    *)           echo "Unknown arg: $1"; show_help; exit 1 ;;
  esac
done

# ── Validate ──────────────────────────────────────────────────────────────────

if [[ "$ACTION" == "run" || "$ACTION" == "daemon" ]]; then
  if [[ -z "$MODE" ]]; then
    echo "ERROR: --mode required. Use --help for usage."
    exit 1
  fi
fi

# ── Init DB (needed for all actions) ──────────────────────────────────────────

init_db() {
  if [[ ! -f "$DB_PATH" ]]; then
    echo "📦 Initializing evolution.db..."
    cd "$REPO_ROOT" && bun run "$EVOLUTION_DIR/init-evolution-db.ts" 2>&1
    echo ""
  fi
}

# ── DB Helpers ────────────────────────────────────────────────────────────────

query() { sqlite3 "$DB_PATH" "$1"; }

# ──────────────────────────────────────────────────────────────────────────────
#  ACTION: RUN — execute one cycle
# ──────────────────────────────────────────────────────────────────────────────

action_run() {
  local cycle_num=$1

  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  the-brain self-evolution — cycle runner                   ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  echo "Mode:  $MODE"
  echo "Agent: $AGENT"
  echo "Repo:  $REPO_ROOT"
  echo ""

  # ── Pre-flight ──────────────────────────────────────────────────────────
  if [[ "$DRY_RUN" != "true" ]]; then
    local current_branch
    current_branch=$(cd "$REPO_ROOT" && git branch --show-current)

    if [[ "$current_branch" != "main" && "$NON_INTERACTIVE" != "true" ]]; then
      echo "⚠️  Not on main branch: $current_branch"
      read -p "   Continue? [y/N] " -n 1 -r; echo
      [[ ! $REPLY =~ ^[Yy]$ ]] && exit 0
    fi

    if ! cd "$REPO_ROOT" && git diff-index --quiet HEAD -- 2>/dev/null; then
      echo "⚠️  Uncommitted changes detected"
      if [[ "$NON_INTERACTIVE" != "true" ]]; then
        read -p "   Continue? [y/N] " -n 1 -r; echo
        [[ ! $REPLY =~ ^[Yy]$ ]] && exit 0
      fi
    fi
  fi

  # ── Get/create batch ────────────────────────────────────────────────────
  local batch_id
  batch_id=$(query "SELECT id FROM batches WHERE status = 'open' ORDER BY id DESC LIMIT 1")

  if [[ -z "$batch_id" ]]; then
    batch_id=$(query "INSERT INTO batches (status) VALUES ('open'); SELECT last_insert_rowid();")
    echo "📦 Created batch #$batch_id"
  else
    echo "📦 Batch #$batch_id"
  fi

  local cycles_count
  cycles_count=$(query "SELECT COUNT(*) FROM cycles WHERE batch_id = $batch_id")

  if [[ "$cycles_count" -ge "$MAX_CYCLES" ]]; then
    echo ""
    echo "✋ BATCH #$batch_id IS FULL ($cycles_count/$MAX_CYCLES)"
    echo "   Run: ./run-cycle.sh --review $batch_id"
    return 1
  fi

  # ── Cycle setup ─────────────────────────────────────────────────────────
  local num
  if [[ -n "$cycle_num" && "$cycle_num" -gt 0 ]]; then
    num=$cycle_num
  else
    local last
    last=$(query "SELECT MAX(cycle_number) FROM cycles")
    num=$((last + 1))
  fi

  local branch="evolve/cycle-${num}-${MODE}"

  echo ""
  echo "─── Cycle #$num ────────────────────────────────────────────"
  echo "   Batch:  #$batch_id (${cycles_count}/${MAX_CYCLES})"
  echo "   Branch: $branch"
  echo ""

  # Insert pending cycle
  query "INSERT INTO cycles (cycle_number, mode, branch_name, batch_id, prediction, verdict)
         VALUES ($num, '$MODE', '$branch', $batch_id, '', 'pending');"
  echo "   📝 Recorded in evolution.db"

  # ── Build prompt ────────────────────────────────────────────────────────
  local prompt_file="$EVOLUTION_DIR/modes/${MODE}.prompt.md"
  if [[ ! -f "$prompt_file" ]]; then
    echo "❌ Prompt not found: $prompt_file"
    query "DELETE FROM cycles WHERE cycle_number = $num AND verdict = 'pending';"
    return 1
  fi

  local prompt
  prompt=$(cat "$prompt_file")

  # Template injection
  prompt="${prompt//__CYCLE_NUMBER__/$num}"
  prompt="${prompt//__CYCLE_ID__/$num}"
  prompt="${prompt//__BATCH_ID__/$batch_id}"
  prompt="${prompt//__MODE__/$MODE}"
  prompt="${prompt//__BRANCH_NAME__/$branch}"
  prompt="${prompt//__REPO_ROOT__/$REPO_ROOT}"
  prompt="${prompt//__EVOLUTION_DIR__/$EVOLUTION_DIR}"
  prompt="${prompt//__MAX_CYCLES__/$MAX_CYCLES}"

  prompt="$prompt

---

## CYCLE-SPECIFIC CONTEXT (injected by run-cycle.sh)

You are cycle #$num, mode: $MODE.
Your branch MUST be named: $branch
Your cycle ID for evaluate.ts: $num

**After implementing and committing:**
\`\`\`bash
bun run experimental/self-evolution-harness/evaluate.ts --cycle-id $num --mode $MODE
\`\`\`

This batch has ${cycles_count}/${MAX_CYCLES} cycles.
After $((MAX_CYCLES - cycles_count - 1)) more, a PR is created for human review."

  if [[ "$DRY_RUN" == "true" ]]; then
    echo ""
    echo "─── DRY RUN — Prompt preview ───────────────────────────────"
    echo ""
    echo "$prompt" | head -80
    echo "..."
    echo "($(echo "$prompt" | wc -l | tr -d ' ') lines)"
    query "DELETE FROM cycles WHERE cycle_number = $num AND verdict = 'pending';"
    return 0
  fi

  # ── Invoke agent ────────────────────────────────────────────────────────
  echo "   🤖 Invoking $AGENT..."
  echo ""

  local agent_exit=0

  case "$AGENT" in
    claude)
      cd "$REPO_ROOT" && claude --prompt "$prompt" || agent_exit=$?
      ;;
    codex)
      cd "$REPO_ROOT" && codex --prompt "$prompt" || agent_exit=$?
      ;;
    hermes)
      echo "For Hermes: use the prompt below, then run evaluate.ts"
      echo ""
      echo "$prompt"
      echo ""
      echo "After Hermes completes:"
      echo "  bun run $EVOLUTION_DIR/evaluate.ts --cycle-id $num --mode $MODE"
      ;;
    *)
      echo "❌ Unknown agent: $AGENT (use: claude, codex, hermes)"
      return 1
      ;;
  esac

  if [[ $agent_exit -ne 0 ]]; then
    echo "⚠️  Agent exit code: $agent_exit"
  fi

  # ── Evaluate ────────────────────────────────────────────────────────────
  echo ""
  echo "   🧪 Evaluating..."

  local eval_out
  eval_out=$(cd "$REPO_ROOT" && bun run "$EVOLUTION_DIR/evaluate.ts" --cycle-id "$num" --mode "$MODE" 2>&1) || true
  echo "$eval_out"

  # ── Report ──────────────────────────────────────────────────────────────
  local verdict
  verdict=$(query "SELECT verdict FROM cycles WHERE cycle_number = $num")

  echo ""
  echo "─── Cycle #$num Complete ───────────────────────────────────"
  echo "   Verdict: $verdict"
  echo "   Branch:  $branch"

  local after_count
  after_count=$(query "SELECT COUNT(*) FROM cycles WHERE batch_id = $batch_id")
  local remaining=$((MAX_CYCLES - after_count))

  echo "   Batch:   #$batch_id (${after_count}/${MAX_CYCLES})"

  if [[ "$verdict" == "rejected" ]]; then
    echo "   ❌ REJECTED — fix on branch then re-evaluate:"
    echo "   bun run $EVOLUTION_DIR/evaluate.ts --cycle-id $num"
  elif [[ "$remaining" -le 0 ]]; then
    echo "   📦 BATCH FULL — time for review!"
    action_submit "$batch_id"
  else
    echo "   ✅ $remaining more cycles to fill batch"
  fi
  echo ""

  return 0
}

# ──────────────────────────────────────────────────────────────────────────────
#  ACTION: REVIEW — interactive HITL batch review
# ──────────────────────────────────────────────────────────────────────────────

action_review() {
  local batch_id=$1

  init_db

  # Resolve batch
  if [[ -z "$batch_id" ]]; then
    batch_id=$(query "SELECT id FROM batches WHERE status = 'submitted' OR status = 'open' ORDER BY id DESC LIMIT 1")
    if [[ -z "$batch_id" ]]; then
      echo "No batches found to review."
      return 1
    fi
  fi

  local batch_status
  batch_status=$(query "SELECT status FROM batches WHERE id = $batch_id")

  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  HITL Batch Review — Batch #$batch_id ($batch_status)     ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""

  # Show cycles
  local cycles
  cycles=$(query "SELECT c.cycle_number, c.mode, c.verdict, c.prediction_accuracy,
                         c.tests_passed || '/' || c.tests_total as tests,
                         ROUND(c.coverage_after - c.coverage_before, 2) as cov_delta,
                         c.prediction,
                         c.hitl_verdict
                  FROM cycles c
                  WHERE c.batch_id = $batch_id
                  ORDER BY c.cycle_number")

  if [[ -z "$cycles" ]]; then
    echo "Batch #$batch_id has no cycles."
    return 0
  fi

  echo "Cycles in batch:"
  echo ""
  printf "  %-4s %-18s %-25s %-10s %-8s %s\n" "#" "Mode" "Verdict" "Tests" "Cov Δ" "HITL"
  echo "  $(printf '─%.0s' {1..90})"

  while IFS='|' read -r num mode verdict pred_acc tests cov_delta prediction hitl; do
    local hitl_mark=""
    [[ "$hitl" == "merged" ]] && hitl_mark="✅"
    [[ "$hitl" == "rejected" ]] && hitl_mark="❌"

    # Truncate prediction for display
    local pred_short="${prediction:0:50}..."
    [[ ${#prediction} -le 50 ]] && pred_short="$prediction"

    printf "  %-4s %-18s %-25s %-10s %-8s %s\n" \
      "#$num" "$mode" "${verdict} (${pred_acc})" "$tests" "${cov_delta}%" "$hitl_mark"
  done <<< "$cycles"

  echo ""

  # ── Per-cycle review ────────────────────────────────────────────────────
  while IFS='|' read -r num mode verdict pred_acc tests cov_delta prediction hitl; do
    [[ -n "$hitl" && "$hitl" != "NULL" ]] && continue  # already reviewed

    echo "─── Cycle #$num ────────────────────────────────────────────"
    echo "   Mode:     $mode"
    echo "   Verdict:  $verdict"
    echo "   Tests:    $tests"
    echo "   Cov Δ:    ${cov_delta}%"
    echo ""
    echo "   Prediction:"
    echo "   $prediction"
    echo ""

    local choice
    if [[ "$NON_INTERACTIVE" == "true" ]]; then
      # Auto-accept confirmed, skip rejected in non-interactive
      if [[ "$verdict" == "confirmed" ]]; then
        choice="m"
        echo "   → Auto-merge (confirmed)"
      else
        echo "   → Skipping (not confirmed)"
        continue
      fi
    else
      read -p "   [m]erge  [r]eject  [s]kip  [f]eedback? " -n 1 -r choice
      echo
    fi

    case $choice in
      m|M)
        query "UPDATE cycles SET hitl_verdict = 'merged', updated_at = datetime('now') WHERE cycle_number = $num"

        # Merge to main — try with branch name from DB
        local branch
        branch=$(query "SELECT branch_name FROM cycles WHERE cycle_number = $num")
        if [[ -n "$branch" ]]; then
          cd "$REPO_ROOT" && git merge "$branch" --no-edit 2>/dev/null && \
          git branch -d "$branch" 2>/dev/null && \
          echo "   ✅ Merged $branch → main"
        fi
        ;;
      r|R)
        query "UPDATE cycles SET hitl_verdict = 'rejected', updated_at = datetime('now') WHERE cycle_number = $num"

        # Clean up branch
        local branch
        branch=$(query "SELECT branch_name FROM cycles WHERE cycle_number = $num")
        [[ -n "$branch" ]] && cd "$REPO_ROOT" && git branch -D "$branch" 2>/dev/null
        echo "   ❌ Rejected"
        ;;
      f|F)
        read -p "   Feedback: " feedback
        read -p "   Category [over-engineering|wrong-approach|good-pattern|bad-prediction|hygiene|performance]: " cat

        query "INSERT INTO feedback_history (cycle_id, category, feedback) VALUES ($num, '$cat', '${feedback//\'/''}')"

        # Also reject the cycle
        query "UPDATE cycles SET hitl_verdict = 'rejected', hitl_feedback = '${feedback//\'/''}', updated_at = datetime('now') WHERE cycle_number = $num"
        local branch
        branch=$(query "SELECT branch_name FROM cycles WHERE cycle_number = $num")
        [[ -n "$branch" ]] && cd "$REPO_ROOT" && git branch -D "$branch" 2>/dev/null
        echo "   📝 Feedback recorded + rejected"
        ;;
      *)
        echo "   ⏭️  Skipped"
        ;;
    esac
    echo ""

  done <<< "$cycles"

  # Update batch status
  local merged_count rejected_count
  merged_count=$(query "SELECT COUNT(*) FROM cycles WHERE batch_id = $batch_id AND hitl_verdict = 'merged'")
  rejected_count=$(query "SELECT COUNT(*) FROM cycles WHERE batch_id = $batch_id AND hitl_verdict = 'rejected'")

  if [[ "$merged_count" -gt 0 ]]; then
    query "UPDATE batches SET status = 'merged', summary = '${merged_count} merged, ${rejected_count} rejected' WHERE id = $batch_id"
    echo "📦 Batch #$batch_id closed: $merged_count merged, $rejected_count rejected"
  fi

  echo ""
  echo "✅ Review complete"
  echo ""
}

# ──────────────────────────────────────────────────────────────────────────────
#  ACTION: SUBMIT — create PR from a batch
# ──────────────────────────────────────────────────────────────────────────────

action_submit() {
  local batch_id=$1

  init_db

  if [[ -z "$batch_id" ]]; then
    batch_id=$(query "SELECT id FROM batches WHERE status = 'open' ORDER BY id DESC LIMIT 1")
    if [[ -z "$batch_id" ]]; then
      echo "No open batches to submit."
      return 1
    fi
  fi

  local cycles_count
  cycles_count=$(query "SELECT COUNT(*) FROM cycles WHERE batch_id = $batch_id AND verdict = 'confirmed'")

  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  Auto-PR — Batch #$batch_id ($cycles_count confirmed)     ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""

  if [[ "$cycles_count" -eq 0 ]]; then
    echo "No confirmed cycles to submit."
    return 0
  fi

  # Build PR body from cycle summaries
  local pr_body="## Self-Evolution Batch #$batch_id\n\n"
  pr_body="$pr_body| # | Mode | Verdict | Tests | Cov Δ | Prediction |\n"
  pr_body="$pr_body|---|------|---------|-------|-------|------------|\n"

  local summary_lines
  summary_lines=$(query "SELECT c.cycle_number, c.mode, c.verdict,
                                c.tests_passed || '/' || c.tests_total,
                                ROUND(c.coverage_after - c.coverage_before, 2),
                                SUBSTR(c.prediction, 1, 60)
                         FROM cycles c
                         WHERE c.batch_id = $batch_id AND c.verdict = 'confirmed'
                         ORDER BY c.cycle_number")

  while IFS='|' read -r num mode verdict tests cov_delta prediction; do
    pr_body="$pr_body| $num | $mode | $verdict | $tests | ${cov_delta}% | ${prediction}... |\n"
  done <<< "$summary_lines"

  pr_body="$pr_body\n"
  pr_body="$pr_body### Human Review Checklist\n"
  pr_body="$pr_body- [ ] All cycles reviewed\n"
  pr_body="$pr_body- [ ] Tests pass\n"
  pr_body="$pr_body- [ ] No unexpected regressions\n"

  # Check if gh CLI is available
  if command -v gh &>/dev/null; then
    echo "   🔧 Creating PR via gh CLI..."
    local pr_url
    pr_url=$(cd "$REPO_ROOT" && gh pr create \
      --title "evolve: batch #$batch_id — $cycles_count confirmed changes" \
      --body "$(echo -e "$pr_body")" \
      --base main \
      --head "$(git branch --show-current)" 2>&1) || true

    if [[ -n "$pr_url" ]]; then
      query "UPDATE batches SET status = 'submitted', pr_url = '${pr_url}' WHERE id = $batch_id"
      echo "   ✅ PR created: $pr_url"
    else
      echo "   ⚠️  PR creation failed. gh CLI output above."
      echo ""
      echo "   Manual PR body:"
      echo -e "$pr_body"
    fi
  else
    echo "   ℹ️  GitHub CLI (gh) not found. Manual PR body:"
    echo ""
    echo -e "$pr_body"
  fi

  echo ""
}

# ──────────────────────────────────────────────────────────────────────────────
#  ACTION: DAEMON — continuous loop
# ──────────────────────────────────────────────────────────────────────────────

action_daemon() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  the-brain self-evolution — DAEMON mode                   ║"
  echo "║  Mode: $MODE | Agent: $AGENT | Batch: $MAX_CYCLES cycles ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""

  init_db

  local iteration=0

  while true; do
    iteration=$((iteration + 1))

    echo "──────────────────────────────────────────────────────"
    echo "DAEMON ITERATION #$iteration — $(date '+%Y-%m-%d %H:%M')"
    echo "──────────────────────────────────────────────────────"

    # Check if there's an open batch
    local batch_id
    batch_id=$(query "SELECT id FROM batches WHERE status = 'open' ORDER BY id DESC LIMIT 1")

    if [[ -z "$batch_id" ]]; then
      batch_id=$(query "INSERT INTO batches (status) VALUES ('open'); SELECT last_insert_rowid();")
      echo "📦 Created batch #$batch_id"
    fi

    local cycles_count
    cycles_count=$(query "SELECT COUNT(*) FROM cycles WHERE batch_id = $batch_id")

    # If batch is full, submit and wait for review
    if [[ "$cycles_count" -ge "$MAX_CYCLES" ]]; then
      echo ""
      echo "📦 Batch #$batch_id full ($cycles_count/$MAX_CYCLES)"
      action_submit "$batch_id"
      echo ""
      echo "⏳ Batch submitted. Waiting for human review..."
      echo "   Run: ./run-cycle.sh --review $batch_id"
      echo "   Daemon sleeping ${DAEMON_SLEEP}s..."
      sleep "$DAEMON_SLEEP"
      continue
    fi

    # Check if batch was already reviewed
    local batch_status
    batch_status=$(query "SELECT status FROM batches WHERE id = $batch_id")
    if [[ "$batch_status" == "merged" || "$batch_status" == "rejected" ]]; then
      echo "✅ Batch #$batch_id $batch_status. Creating new batch..."
      batch_id=$(query "INSERT INTO batches (status) VALUES ('open'); SELECT last_insert_rowid();")
      echo "📦 Created batch #$batch_id"
    fi

    # Run one cycle
    action_run ""

    # If cycle failed (returned non-zero), it was probably rejected — sleep and retry
    local last_verdict
    last_verdict=$(query "SELECT verdict FROM cycles ORDER BY cycle_number DESC LIMIT 1")
    if [[ "$last_verdict" == "rejected" ]]; then
      echo "⚠️  Last cycle rejected. Sleeping ${DAEMON_SLEEP}s before retry..."
      sleep "$DAEMON_SLEEP"
      continue
    fi

    # Quick pause between cycles
    sleep 5
  done
}

# ──────────────────────────────────────────────────────────────────────────────
#  MAIN DISPATCH
# ──────────────────────────────────────────────────────────────────────────────

init_db

case "$ACTION" in
  run)
    action_run ""
    ;;
  review)
    action_review "$BATCH_ID"
    ;;
  submit)
    action_submit "$BATCH_ID"
    ;;
  daemon)
    action_daemon
    ;;
  *)
    echo "Unknown action: $ACTION"
    show_help
    exit 1
    ;;
esac
