#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

version=$(tr -d '[:space:]' < VERSION)
[[ $version =~ ^[0-9]+(\.[0-9]+){1,2}$ ]] || {
  echo "Invalid VERSION: $version" >&2
  exit 1
}

[[ -z $(git status --porcelain) ]] || {
  echo "Commit all changes before creating a release." >&2
  exit 1
}

notes_file=$(mktemp)
trap 'rm -f "$notes_file"' EXIT

awk -v version="$version" '
  $0 == "## [" version "]" || index($0, "## [" version "] - ") == 1 { found = 1; next }
  found && /^## / { exit }
  found {
    if (!content && $0 ~ /^[[:space:]]*$/) next
    print
    if ($0 !~ /^[[:space:]]*$/) content = 1
  }
  END { if (!found || !content) exit 1 }
' CHANGELOG.md > "$notes_file" || {
  echo "CHANGELOG.md has no release notes for $version." >&2
  exit 1
}

tag="v$version"
gh release create "$tag" \
  --target "$(git rev-parse HEAD)" \
  --title "Cipherleaf $tag" \
  --notes-file "$notes_file"
