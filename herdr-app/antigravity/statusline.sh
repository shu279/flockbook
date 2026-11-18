#!/usr/bin/env bash
# Based on the user's Antigravity CLI statusline.sh. Keeps its ANSI palette,
# model/effort, grouped totals, subagent estimate, and width-aware terminal UI.
# The adjacent Python helper also writes a small per-session/per-terminal cache
# for Flockbook. It uses no network; the original settings command stays valid.

set -uo pipefail
export LC_ALL=C

R=$'\033[0m'
B=$'\033[1m'
FG_GRAY=$'\033[90m'
FG_CYAN=$'\033[96m'
FG_GREEN=$'\033[92m'
FG_MAGENTA=$'\033[95m'
FG_YELLOW=$'\033[93m'
FG_WHITE=$'\033[97m'

format_int() {
  local raw="${1:-}"
  [[ "$raw" =~ ^[0-9]+$ ]] || { printf 'N/A'; return; }
  local out=""
  while [[ ${#raw} -gt 3 ]]; do
    out=",${raw: -3}${out}"
    raw="${raw:0:${#raw}-3}"
  done
  printf '%s%s' "$raw" "$out"
}

format_cost() {
  local raw="${1:-}"
  # jq below has already checked that these are finite, nonnegative numbers.
  if [[ -z "$raw" || "$raw" == "N/A" ]]; then
    printf 'N/A'
  elif awk -v n="$raw" 'BEGIN { exit !(n > 0 && n < 0.00005) }' 2>/dev/null; then
    printf '<$0.0001'
  else
    printf '$%.4f' "$raw" 2>/dev/null || printf 'N/A'
  fi
}

PAYLOAD="$(cat 2>/dev/null || true)"
[[ -n "${PAYLOAD//[[:space:]]/}" ]] || PAYLOAD='{}'
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE="$(printf '%s' "$PAYLOAD" | python3 "$SCRIPT_DIR/statusline_bridge.py" 2>/dev/null)" || BRIDGE='{}'
[[ -n "$BRIDGE" ]] || BRIDGE='{}'

PARSED="$(printf '%s' "$PAYLOAD" | jq -r --argjson bridge "$BRIDGE" '
  def numeric: if type == "number" and . >= 0 and . < 1.7976931348623157e308 then . else null end;
  def value: if . == null then "N/A" else tostring end;
  (.model // {}) as $model
  | (($model.display_name // $model.id // "N/A") | tostring | gsub("[[:cntrl:]]"; "")) as $name
  | (($model.effort // "") | tostring | gsub("[[:cntrl:]]"; "")) as $effort
  | (if $effort != "" and ($name | contains("(") | not) then "\($name) (\($effort))" else $name end),
    (($bridge.input_tokens | numeric) | if . == null then "N/A" else floor | tostring end),
    (($bridge.output_tokens | numeric) | if . == null then "N/A" else floor | tostring end),
    ((.cost.total_usd | numeric) | value),
    ((.cost.subagent_usd | numeric) | value),
    ((.terminal_width // 100) | tonumber? // 100 | floor | tostring),
    ((.agent_state // "unknown") | tostring),
    (if $bridge.turn.complete == true and ($bridge.turn.elapsed_ms | numeric) != null then
       (($bridge.turn.elapsed_ms / 1000) | floor | tostring) + "s"
     else "N/A" end)
' 2>/dev/null)" || PARSED=''

if [[ -n "$PARSED" ]]; then
  {
    IFS= read -r MODEL_NAME
    IFS= read -r TOTAL_IN
    IFS= read -r TOTAL_OUT
    IFS= read -r TOTAL_USD
    IFS= read -r SUBAGENT_USD
    IFS= read -r TERM_COLS
    IFS= read -r AGENT_STATE
    IFS= read -r TURN_TIME_STR
  } <<< "$PARSED"
else
  MODEL_NAME='N/A'; TOTAL_IN='N/A'; TOTAL_OUT='N/A'
  TOTAL_USD='N/A'; SUBAGENT_USD='N/A'; TERM_COLS=100
  AGENT_STATE='unknown'; TURN_TIME_STR='N/A'
fi

IN_FMT="$(format_int "$TOTAL_IN")"
OUT_FMT="$(format_int "$TOTAL_OUT")"
TOTAL_USD_FMT="$(format_cost "$TOTAL_USD")"
SUB_USD_FMT="$(format_cost "$SUBAGENT_USD")"
SEP="${FG_GRAY} │ ${R}"
DOT="${FG_GRAY} · ${R}"

SEG_MODEL="${FG_GRAY}Model:${R} ${FG_MAGENTA}${B}${MODEL_NAME}${R}"
SEG_IN="${FG_GRAY}In:${R} ${FG_WHITE}${B}${IN_FMT}${R}"
SEG_OUT="${FG_GRAY}Out:${R} ${FG_WHITE}${B}${OUT_FMT}${R}"
SEG_COST="${FG_GRAY}Est:${R} ${FG_GREEN}${B}${TOTAL_USD_FMT}${R}"
if [[ "$SUBAGENT_USD" != 'N/A' ]] && awk -v n="$SUBAGENT_USD" 'BEGIN { exit !(n > 0) }' 2>/dev/null; then
  SEG_COST="${SEG_COST} ${FG_CYAN}(sub ${SUB_USD_FMT})${R}"
fi

STATE_TAG="${AGENT_STATE//[^a-zA-Z0-9_-]/}"
[[ -n "$STATE_TAG" ]] || STATE_TAG='unknown'
if [[ "$TURN_TIME_STR" == 'N/A' ]]; then
  SEG_TURN="${FG_GRAY}Turn:${R} ${FG_WHITE}${B}N/A${R}"
elif [[ "$STATE_TAG" == 'idle' ]]; then
  SEG_TURN="${FG_GRAY}Turn(done):${R} ${FG_WHITE}${B}${TURN_TIME_STR}${R}"
else
  SEG_TURN="${FG_GRAY}Turn(${STATE_TAG}):${R} ${FG_YELLOW}${B}${TURN_TIME_STR}${R}"
fi

[[ "$TERM_COLS" =~ ^[0-9]+$ ]] || TERM_COLS=100
if [[ "$TERM_COLS" -ge 110 ]]; then
  printf '%s%s%s%s%s%s%s%s%s\n' \
    "$SEG_MODEL" "$SEP" "$SEG_IN" "$DOT" "$SEG_OUT" "$SEP" "$SEG_COST" "$SEP" "$SEG_TURN"
elif [[ "$TERM_COLS" -ge 76 ]]; then
  printf '%s%s%s%s%s%s%s\n%s\n' \
    "$SEG_MODEL" "$SEP" "$SEG_IN" "$DOT" "$SEG_OUT" "$SEP" "$SEG_COST" "$SEG_TURN"
else
  printf '%s\n%s%s%s%s%s\n%s\n' \
    "$SEG_MODEL" "$SEG_IN" "$DOT" "$SEG_OUT" "$DOT" "$SEG_COST" "$SEG_TURN"
fi
