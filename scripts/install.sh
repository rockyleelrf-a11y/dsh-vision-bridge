#!/usr/bin/env bash
# dsh-vision-bridge installer
#
# Installs the plugin into a running DeepSeek Harness web profile:
#   1. copies the package into the loader's resolution source
#      ($DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-vision-bridge)
#   2. adds the composition row to $DSH_HOME/profiles/web/cordis.patch.yml
#   3. patches the dsh-host-apiproxy image-admission gate (session.prompt)
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

# ---- 1. package ----
echo "== 1/4 install package =="
mkdir -p "$PKG_DST"
cp -R "$SCRIPT_DIR/../package.json" "$PKG_DST/package.json"
cp -R "$SCRIPT_DIR/../lib" "$PKG_DST/lib/"
echo "installed to $PKG_DST"

# ---- 2. composition row ----
echo "== 2/4 add composition row =="
PATCH_FILE="$WEB_DIR/cordis.patch.yml"
if [[ -f "$PATCH_FILE" ]] && grep -q "dsh-vision-bridge" "$PATCH_FILE" 2>/dev/null; then
  echo "row already present in $PATCH_FILE, skipping"
else
  # append an insert block (the patch file is a top-level YAML list)
  cat >> "$PATCH_FILE" <<EOF

- insert:
    - id: vision-bridge
      name: '$PKG_NAME'
EOF
  echo "row added to $PATCH_FILE"
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
OLD = """						if (hasImage) {
							const current = selectionFor(agent).current;
							const modelInfo = await ctx.llm.resolveModelInfo(current.provider, current.model);
							if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")) return err(request, {
								code: "attachment-error",
								message: `Model "${current.model}" does not support image input.`,
								details: { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" }
							});
						}"""
NEW = """						if (hasImage) {
							// Vision-bridge override (local deployment patch): allow
							// pasted-image messages to reach the agent loop, where the
							// vision-bridge `llm/stream` listener converts image blocks
							// into vision-model text descriptions before the request
							// reaches the text-only main model.
						}"""
if OLD not in src:
    print("error: could not find the exact admission block to patch; your dsh-host-apiproxy version may differ (see README)", file=sys.stderr)
    sys.exit(1)
open(path, 'w', encoding='utf-8').write(src.replace(OLD, NEW, 1))
print("admission patch applied")
PYEOF
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