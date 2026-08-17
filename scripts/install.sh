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

# ---- 3. apiproxy admission patch ----
echo "== 3/4 patch host-apiproxy admission =="
# Locate the installed dsh-host-apiproxy (follows pnpm symlinks from the profile tree)
APIPROXY=$(readlink -f "$PROFILE_DIR/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js" 2>/dev/null || echo "$PROFILE_DIR/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js")
if [[ ! -f "$APIPROXY" ]]; then
  echo "warning: dsh-host-apiproxy not found at $APIPROXY; skipping admission patch" >&2
elif grep -q "Vision-bridge override" "$APIPROXY"; then
  echo "admission patch already applied, skipping"
else
  python3 - "$APIPROXY" <<'PYEOF'
import sys
path = sys.argv[1]
src = open(path, encoding='utf-8').read()
OLD = """\t\t\t\t\t\t\t\tif (hasImage) {
\t\t\t\t\t\t\t\t\tconst current = selectionFor(agent).current;
\t\t\t\t\t\t\t\t\tconst modelInfo = await ctx.llm.resolveModelInfo(current.provider, current.model);
\t\t\t\t\t\t\t\t\tif (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")) return err(request, {
\t\t\t\t\t\t\t\t\t\tcode: "attachment-error",
\t\t\t\t\t\t\t\t\t\tmessage: `Model "${current.model}" does not support image input.`,
\t\t\t\t\t\t\t\t\t\tdetails: { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" }
\t\t\t\t\t\t\t\t\t});
\t\t\t\t\t\t\t\t}"""
NEW = """\t\t\t\t\t\t\t\tif (hasImage) {
\t\t\t\t\t\t\t\t\t// Vision-bridge override (local deployment patch): allow
\t\t\t\t\t\t\t\t\t// pasted-image messages to reach the agent loop, where the
\t\t\t\t\t\t\t\t\t// vision-bridge `llm/stream` listener converts image blocks
\t\t\t\t\t\t\t\t\t// into vision-model text descriptions before the request
\t\t\t\t\t\t\t\t\t// reaches the text-only main model.
\t\t\t\t\t\t\t\t}"""
if OLD not in src:
    print("error: could not find the exact admission block to patch; your dsh-host-apiproxy version may differ (see README)", file=sys.stderr)
    sys.exit(1)
open(path, 'w', encoding='utf-8').write(src.replace(OLD, NEW, 1))
print("admission patch applied")
PYEOF

  # Also patch the model-switch gate (selectModel endpoint) so text-only models
  # can be selected in sessions that already contain images.
  if grep -q "does not accept image input" "$APIPROXY"; then
    python3 - "$APIPROXY" <<'PYEOF2'
import sys
path = sys.argv[1]
src = open(path, encoding='utf-8').read()
idx = src.find('does not accept image input')
if idx < 0:
    print('model-switch gate already patched')
    sys.exit(0)
NL = chr(10)
line_start = src.rfind(NL, 0, idx) + 1
block_start = src.rfind(NL, 0, line_start) + 1
if_start_idx = src.rfind('if ([...found.agent', 0, block_start)
full_line_start = if_start_idx - 6
brace_start = src.find('{', if_start_idx)
depth = 0
outer_depth = 0
for j in range(brace_start, brace_start + 500):
    if src[j] == '{':
        if outer_depth == 0:
            outer_depth += 1
        depth += 1
    elif src[j] == '}':
        depth -= 1
        if outer_depth == 1 and depth == 0:
            brace_end = j
            break
OLD = src[full_line_start:brace_end+1]
TAB = chr(9)
NEW = (TAB*6 + '// Vision-bridge override (local deployment patch): allow model switch to text-only
'
     + TAB*6 + '// models in sessions with images. The vision-bridge llm/stream listener
'
     + TAB*6 + '// converts image blocks to text descriptions before the request reaches the adapter.
'
     + TAB*6 + 'if (false) { /* vision-bridge: image-admission gate disabled for model switch */ }
')
count = src.count(OLD)
if count != 1:
    print('error: model-switch block found %d times (expected 1)' % count, file=sys.stderr)
    sys.exit(1)
open(path, 'w', encoding='utf-8').write(src.replace(OLD, NEW, 1))
print('model-switch admission patch applied')
PYEOF2
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