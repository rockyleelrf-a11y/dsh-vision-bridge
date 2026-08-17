#!/usr/bin/env bash
# dsh-vision-bridge installer
#
# Installs the plugin into a running DeepSeek Harness web profile:
#   1. copies the package into the loader's resolution source
#      ($DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-vision-bridge)
#   2. repairs any corrupted cordis.patch.yml (empty `[]` root + dangling `- insert:`)
#   3. adds the composition row to $DSH_HOME/profiles/web/cordis.patch.yml
#   4. patches the dsh-host-apiproxy image-admission gate (session.prompt)
#
# Idempotent: safe to re-run, e.g. after a DSH upgrade wiped the patches.
#
# Usage: bash scripts/install.sh [--dsh-home DIR]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dsh-home) DSH_HOME="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: bash scripts/install.sh [--dsh-home DIR]"
      echo "  --dsh-home  DSH home directory (default: \$HOME/.dsh)"
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

PKG_NAME="@deepseek-ai/dsh-vision-bridge"
PROFILE_DIR="$DSH_HOME/profiles"
WEB_DIR="$PROFILE_DIR/web"
PKG_DST="$PROFILE_DIR/node_modules/$PKG_NAME"

echo "== dsh-vision-bridge installer =="
echo "DSH home : $DSH_HOME"

# ---- sanity checks ----
[[ -d "$WEB_DIR" ]] || { echo "error: web profile not found at $WEB_DIR (wrong --dsh-home?)" >&2; exit 1; }
[[ -f "$SCRIPT_DIR/../lib/index.js" ]] || { echo "error: lib/index.js missing (run from the repo root layout)" >&2; exit 1; }

PATCH_FILE="$WEB_DIR/cordis.patch.yml"

# ---- 0. Repair any pre-existing YAML corruption ----
# An earlier version of this installer blindly appended `- insert:` to the
# default `[]` template, creating two YAML documents in one file. DSH's
# parsePatchList expects a single YAML array and throws a YAML error,
# preventing the service from starting.  Repair it before we touch the file.
if [[ -f "$PATCH_FILE" ]]; then
  if grep -q '^[][\]$' "$PATCH_FILE" 2>/dev/null; then
    echo "== 0/4 repairing corrupted cordis.patch.yml =="
    INSERT_BLOCK=$(sed -n '/^- insert:/,$p' "$PATCH_FILE" 2>/dev/null || true)
    if [[ -n "$INSERT_BLOCK" ]]; then
      cat > "$PATCH_FILE" <<EOF
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).

$INSERT_BLOCK
EOF
      echo "repaired: removed orphaned '[]' root, kept insert block(s)"
    else
      echo "file had '[]' but no insert block — leaving as-is"
    fi
  fi
fi

# ---- 1. package ----
echo "== 1/4 install package =="
mkdir -p "$PKG_DST"
cp -R "$SCRIPT_DIR/../package.json" "$PKG_DST/package.json"
cp -R "$SCRIPT_DIR/../lib" "$PKG_DST/lib/"
echo "installed to $PKG_DST"

# ---- 2. composition row ----
echo "== 2/4 add composition row =="
if [[ -f "$PATCH_FILE" ]] && grep -q "dsh-vision-bridge" "$PATCH_FILE" 2>/dev/null; then
  echo "row already present in $PATCH_FILE, skipping"
else
  # The patch file must be a SINGLE YAML array (the top-level patch entry list).
  # The default template ships as `[]` (empty root array).  Blindly appending
  # to it creates two YAML documents in one file, which crashes parsePatchList
  # with a YAML error.  Instead, detect the empty template and replace it,
  # or append to an already-populated file.
  if [[ ! -f "$PATCH_FILE" ]]; then
    # File doesn't exist yet — create it from scratch
    cat > "$PATCH_FILE" <<EOF
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).

- insert:
    - id: vision-bridge
      name: '$PKG_NAME'
EOF
    echo "file created at $PATCH_FILE"
  elif grep -q '^[][\]$' "$PATCH_FILE" 2>/dev/null; then
    # Empty template — replace the whole file
    cat > "$PATCH_FILE" <<EOF
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).

- insert:
    - id: vision-bridge
      name: '$PKG_NAME'
EOF
    echo "row added to $PATCH_FILE (replaced empty template)"
  else
    # Already has content — append cleanly
    cat >> "$PATCH_FILE" <<EOF

- insert:
    - id: vision-bridge
      name: '$PKG_NAME'
EOF
    echo "row appended to $PATCH_FILE"
  fi
fi

# ---- 3. deepseek model capability declaration ----
echo "== 3/4 patch deepseek model capability declaration =="
# The image admission gates in dsh-host-apiproxy (paste + model-switch) both
# trust llm.resolveModelInfo(...).inputModalities. The deepseek adapter
# hard-codes ["text"], so a text-only main model rejects image messages.
# Declaring image input on the deepseek route makes both gates pass — and the
# vision-bridge llm/stream listener converts image blocks to text BEFORE they
# reach the adapter, so the deepseek API never receives image content.
#
# This is a tiny, brace-free string replacement on the adapter's capability
# declaration. It does NOT touch dsh-host-apiproxy or dsh-client-connection.
LLMDEEPSEEK=$(readlink -f "$PROFILE_DIR/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js" 2>/dev/null || echo "$PROFILE_DIR/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js")
if [[ ! -f "$LLMDEEPSEEK" ]]; then
  echo "warning: dsh-llm-deepseek not found at $LLMDEEPSEEK; skipping capability patch" >&2
elif ! node --check "$LLMDEEPSEEK" 2>/dev/null; then
  echo "error: dsh-llm-deepseek is ALREADY broken (syntax check failed); refusing to patch." >&2
  echo "       This usually means the DeepSeek Harness installation is corrupted." >&2
  echo "       Reinstall DeepSeek Harness first, then re-run this installer." >&2
else
  cp "$LLMDEEPSEEK" "$LLMDEEPSEEK.vb-bak"
  python3 - "$LLMDEEPSEEK" <<'PYEOF'
import sys
path = sys.argv[1]
try:
    src = open(path, encoding='utf-8').read()
except OSError as e:
    print('warning: cannot read %s (%s) — skipping' % (path, e))
    sys.exit(0)
OLD = 'inputModalities: ["text"]'
NEW = 'inputModalities: ["text", "image"]'
count = src.count(OLD)
if count == 0:
    if 'inputModalities: ["text", "image"]' in src:
        print('deepseek capability: already patched, skipping')
    else:
        print('warning: no `inputModalities: ["text"]` found — this DSH version may differ; skipping')
    sys.exit(0)
try:
    open(path, 'w', encoding='utf-8').write(src.replace(OLD, NEW))
except OSError as e:
    print('warning: cannot write %s (%s) — patch NOT persisted' % (path, e), file=sys.stderr)
    sys.exit(0)
print('deepseek capability: patched (%d occurrence(s))' % count)
PYEOF
  if ! node --check "$LLMDEEPSEEK" 2>/dev/null; then
    cp "$LLMDEEPSEEK.vb-bak" "$LLMDEEPSEEK"
    echo "error: patched dsh-llm-deepseek failed a syntax check; original restored from $LLMDEEPSEEK.vb-bak" >&2
  else
    echo "deepseek capability patch OK (syntax verified)"
  fi
fi

# ---- 4. reminder ----
echo "== 4/4 done =="
echo ""
echo "Next steps:"
echo "  1. Configure a vision provider in $DSH_HOME/settings.yaml, e.g.:"
echo ""
echo "     llm-pi-ai:"
echo "       providers:"
echo "         sense:"
echo "           displayName: SenseNova"
echo "           apiKeyEnv: SENSE_API_KEY"
echo "           api: openai-completions"
echo "           baseURL: https://token.sensenova.cn/v1"
echo "           models:"
echo "             - id: sensenova-6.8-flash-lite"
echo "               name: sensenova-6.8-flash-lite"
echo "               contextWindow: 262144"
echo "               input: [text, image]"
echo ""
echo "  2. Set the API key (e.g. in $DSH_HOME/.credentials.yaml as SENSE_API_KEY)."
echo "  3. Fully restart the DSH service process (quit the app, verify the port"
echo "     is free, reopen) - composition and the browser roster load at startup."
echo "  4. Verify: Settings > Plugins shows 'dsh-vision-bridge'; a 📷 button"
echo "     appears in the composer; POST /vision-upload returns 400 while the"
echo "     plugin is loaded (405 when it is not)."