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

# ---- 3. apiproxy admission patches (paste + model-switch) ----
echo "== 3/4 patch host-apiproxy admission =="
# Locate the installed dsh-host-apiproxy (follows pnpm symlinks from the profile tree)
APIPROXY=$(readlink -f "$PROFILE_DIR/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js" 2>/dev/null || echo "$PROFILE_DIR/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js")
if [[ ! -f "$APIPROXY" ]]; then
  echo "warning: dsh-host-apiproxy not found at $APIPROXY; skipping admission patches" >&2
else
  # Safety: back up before touching, then verify syntax after; roll back on failure.
  cp "$APIPROXY" "$APIPROXY.vb-bak"
  python3 - "$APIPROXY" <<'PYEOF'
import sys, re

path = sys.argv[1]
try:
    src = open(path, encoding='utf-8').read()
except OSError as e:
    print('warning: cannot read %s (%s) — skipping admission patches' % (path, e))
    sys.exit(0)

TAB = chr(9)
out = []

def if_statement_bounds(text, if_pos):
    """Extent of the whole if-statement starting at if_pos:
    (body_start, body_end) covering a {...} block or a single statement,
    balancing parens/braces so we never clip mid-expression."""
    # 1. skip the condition (balanced parens)
    depth = 0
    i = if_pos + 2
    while i < len(text):
        c = text[i]
        if c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
            if depth == 0:
                i += 1
                break
        i += 1
    # 2. skip whitespace / newlines
    j = i
    while j < len(text) and text[j] in ' \t\r\n':
        j += 1
    if j < len(text) and text[j] == '{':
        # block statement — balance braces
        depth = 0
        k = j
        while k < len(text):
            c = text[k]
            if c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    return if_pos, k
            k += 1
        return None, None
    # 3. single statement — scan to ';' balancing (), {}, [] (cross-line safe)
    depth = 0
    k = j
    while k < len(text):
        c = text[k]
        if c in '({[':
            depth += 1
        elif c in ')}]':
            depth -= 1
        elif c == ';' and depth == 0:
            return if_pos, k
        elif c == '\n' and depth == 0:
            return if_pos, k - 1
        k += 1
    return None, None

def find_enclosing_if(text, anchor):
    """Nearest line-start `if (` before the anchor whose statement body
    contains the anchor.  Anchors on line-start ifs only, so comments or
    strings containing 'if (' are never picked up."""
    idx = text.find(anchor)
    if idx < 0:
        return None, None
    best = None
    for m in re.finditer(r'(?m)^[ \t]*if \(', text):
        if m.start() >= idx:
            break
        body_start, body_end = if_statement_bounds(text, m.start())
        if body_start is not None and body_end > idx:
            best = (m.start(), body_end)
    return best if best is not None else (None, None)

# ---- patch 1: session.prompt paste admission gate ----
if_pos, end = find_enclosing_if(src, 'MODEL_DOES_NOT_SUPPORT_IMAGES')
if if_pos is None:
    if 'inputModalities' in src:
        out.append('paste admission: no MODEL_DOES_NOT_SUPPORT_IMAGES gate found (already patched, or this DSH version uses a different check) — skipping')
    else:
        out.append('paste admission: no image gate found in this DSH version, skipping')
else:
    old = src[if_pos:end + 1]
    new = (TAB * 6 + '// Vision-bridge override (local deployment patch): allow pasted-image messages to reach the agent loop.\n'
           + TAB * 6 + 'if (false) { /* vision-bridge: paste image admission gate disabled */ }\n')
    src = src.replace(old, new, 1)
    out.append('paste admission: patched')

# ---- patch 2: selectModel model-switch gate ----
anchor = 'does not accept image input'
if anchor not in src:
    anchor = 'does not support image input'
if anchor not in src:
    out.append('model-switch gate: not found (already patched, or this DSH version differs) — skipping')
else:
    if_pos, end = find_enclosing_if(src, anchor)
    if if_pos is None:
        out.append('warning: model-switch image gate found but its if-statement could not be located — not patched')
    else:
        old = src[if_pos:end + 1]
        new = (TAB * 6 + '// Vision-bridge override (local deployment patch): allow model switch to text-only models in image sessions.\n'
               + TAB * 6 + 'if (false) { /* vision-bridge: model-switch image admission gate disabled */ }\n')
        src = src.replace(old, new, 1)
        out.append('model-switch gate: patched')

try:
    open(path, 'w', encoding='utf-8').write(src)
except OSError as e:
    print('warning: cannot write %s (%s) — patches NOT persisted' % (path, e), file=sys.stderr)
    sys.exit(0)

for line in out:
    print(line)
PYEOF
  PY_RC=$?
  if [[ $PY_RC -ne 0 ]]; then
    cp "$APIPROXY.vb-bak" "$APIPROXY"
    echo "error: apiproxy patching failed (exit $PY_RC); original restored from $APIPROXY.vb-bak" >&2
  elif ! node --check "$APIPROXY" 2>/dev/null; then
    cp "$APIPROXY.vb-bak" "$APIPROXY"
    echo "error: patched dsh-host-apiproxy failed a syntax check; original restored from $APIPROXY.vb-bak" >&2
    echo "       If you need the vision-bridge admission patches, this DSH version is not"
    echo "       supported by the automatic patcher — please report the DSH version." >&2
  else
    echo "admission patches OK (syntax verified)"
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