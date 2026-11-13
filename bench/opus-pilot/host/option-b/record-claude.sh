#!/bin/sh
# KAN-113 10600 §2 (Option B wiring test): a RECORDING fake for `path_to_claude_code_executable`.
# It never contacts any service. It records what the official action passes to the CLI: argv, the NAMES of
# environment variables (values never), whether the injected synthetic token reached it, and the first bytes of
# stdin (hashed + length, plus the first JSON message type). Then it exits 1 so the action stops.
set -u
OUT="${RUNNER_TEMP:-/tmp}/kan113-option-b"; mkdir -p "$OUT"
if [ "${1:-}" = "--version" ] || [ "${1:-}" = "-v" ]; then echo "2.1.322 (Claude Code)"; printf '%s\n' "version-probe" >> "$OUT/calls.txt"; exit 0; fi
n=$(ls "$OUT" | grep -c '^call-' || true); f="$OUT/call-$n.json"
stdin_file="$OUT/stdin-$n.bin"; timeout 5 head -c 8192 > "$stdin_file" 2>/dev/null || true
node -e '
const fs = require("fs"); const [f, stdinFile, dummy] = process.argv.slice(1);
const st = fs.readFileSync(stdinFile); let firstType = null;
try { firstType = JSON.parse(st.toString("utf8").split("\n")[0]).type || null; } catch {}
const rec = { argv: process.argv.slice(4), env_names: Object.keys(process.env).sort(),
  oauth_token_present: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN), oauth_token_is_injected_dummy: process.env.CLAUDE_CODE_OAUTH_TOKEN === dummy,
  anthropic_api_key_present: Boolean(process.env.ANTHROPIC_API_KEY), anthropic_base_url: process.env.ANTHROPIC_BASE_URL || null,
  subprocess_env_scrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB || null, entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT || null,
  stdin: { bytes: st.length, sha256: require("crypto").createHash("sha256").update(st).digest("hex"), first_message_type: firstType } };
fs.writeFileSync(f, JSON.stringify(rec, null, 2));
' "$f" "$stdin_file" "${QB_OPTION_B_DUMMY:-}" "$@"
rm -f "$stdin_file"
echo "qb option-b recording fake: stopping (no model call)" >&2
exit 1
