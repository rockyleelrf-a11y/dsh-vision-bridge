#!/usr/bin/env bash
# fix-patch.sh — Repair a broken cordis.patch.yml that crashes DSH startup
#
# Problem: an earlier version of the dsh-vision-bridge installer blindly
# appended the `- insert:` block to the default `[]` template, creating two
# YAML documents in one file.  DSH's parsePatchList expects a single YAML
# array and throws a YAML error ("end of the stream or a document separator
# is expected"), preventing the service from starting.
#
# This script detects the `[]` + dangling `- insert:` pattern and repairs
# the file by keeping only the header comment and the insert block(s).
#
# Usage: bash scripts/fix-patch.sh [--dsh-home DIR]
#   (default DSH_HOME = ~/.dsh)
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dsh-home) DSH_HOME="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: bash scripts/fix-patch.sh [--dsh-home DIR]"
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

PATCH_FILE="$DSH_HOME/profiles/web/cordis.patch.yml"
if [[ ! -f "$PATCH_FILE" ]]; then
  echo "patch file not found at $PATCH_FILE — nothing to fix" >&2
  exit 0
fi

echo "Checking $PATCH_FILE …"

# Strategy: detect any `[]` line that is followed by non-comment content
# (i.e. a dangling `- insert:` block).  If found, extract everything from
# the first `- insert:` to end-of-file and rewrite the file.
INSERT_BLOCK=""
IN_INSERT=0
while IFS= read -r line; do
  # Detect start of an insert block
  if [[ "$line" =~ ^-[-[:space:]]*insert: ]] && [[ $IN_INSERT -eq 0 ]]; then
    IN_INSERT=1
  fi
  if [[ $IN_INSERT -eq 1 ]]; then
    if [[ -z "$INSERT_BLOCK" ]]; then
      INSERT_BLOCK="$line"
    else
      INSERT_BLOCK="$INSERT_BLOCK"$'\n'"$line"
    fi
  fi
done < "$PATCH_FILE"

if [[ -z "$INSERT_BLOCK" ]]; then
  echo "No insert block found in file.  Nothing to repair."
  exit 0
fi

# Check if the file has the corrupted `[]` root pattern
if grep -q '^[][\]$' "$PATCH_FILE" 2>/dev/null; then
  echo "Detected orphaned '[]' root — repairing file."
  cat > "$PATCH_FILE" <<EOF
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).

$INSERT_BLOCK
EOF
  echo "Repaired.  Restart DSH for the fix to take effect."
elif grep -q '^-\s*insert:' "$PATCH_FILE" 2>/dev/null; then
  # File has insert blocks but no orphaned `[]` — it might be healthy
  # but let's verify it's a single valid YAML array
  echo "File has insert blocks.  Checking YAML validity…"
  if python3 -c "
import yaml, sys
try:
    data = yaml.safe_load(open('$PATCH_FILE'))
    if isinstance(data, list):
        print('Valid YAML array — nothing to fix.')
        sys.exit(0)
    elif data is None:
        print('Empty YAML document — nothing to fix.')
        sys.exit(0)
    else:
        print('Warning: YAML parsed but is not a list (got %s). Manual check recommended.' % type(data).__name__, file=sys.stderr)
        sys.exit(1)
except yaml.YAMLError as e:
    print('YAML error detected — attempting repair: ' + str(e), file=sys.stderr)
    sys.exit(1)
" 2>&1; then
    echo "File is valid.  Nothing to fix."
    exit 0
  else
    echo "YAML is invalid — repairing."
    cat > "$PATCH_FILE" <<EOF
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).

$INSERT_BLOCK
EOF
    echo "Repaired.  Restart DSH for the fix to take effect."
  fi
else
  echo "File looks healthy (no insert blocks or orphaned '[]').  Nothing to fix."
fi