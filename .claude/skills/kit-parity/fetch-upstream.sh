#!/usr/bin/env bash
# Fetch the SvelteKit files that svelte-local-query is ported from, hash them, and
# compare against baseline.json to detect upstream changes.
#
# Usage:
#   fetch-upstream.sh check              # download + report files changed since baseline
#   fetch-upstream.sh baseline           # download + rewrite baseline.json from current upstream
#   fetch-upstream.sh download <dir>     # just download everything into <dir>
#
# Files are downloaded into ./kit-upstream by default (or <dir> for `download`),
# preserving upstream relative paths. Exit code of `check` is 1 when changes exist.

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASELINE="$SKILL_DIR/baseline.json"
BASE_URL="https://raw.githubusercontent.com/sveltejs/kit/main"

MODE="${1:-check}"
OUT_DIR="${2:-./kit-upstream}"

# Upstream files this library is ported from. Keep in sync with the mapping table in
# SKILL.md when adding coverage.
FILES=(
	packages/kit/src/runtime/client/remote-functions/index.js
	packages/kit/src/runtime/client/remote-functions/shared.svelte.js
	packages/kit/src/runtime/client/remote-functions/cache.svelte.js
	packages/kit/src/runtime/client/remote-functions/command.svelte.js
	packages/kit/src/runtime/client/remote-functions/form.svelte.js
	packages/kit/src/runtime/client/remote-functions/query-batch.svelte.js
	packages/kit/src/runtime/client/remote-functions/prerender.svelte.js
	packages/kit/src/runtime/client/remote-functions/query/index.js
	packages/kit/src/runtime/client/remote-functions/query/instance.svelte.js
	packages/kit/src/runtime/client/remote-functions/query/proxy.js
	packages/kit/src/runtime/client/remote-functions/query/cache.js
	packages/kit/src/runtime/client/remote-functions/query/proxy.svelte.spec.js
	packages/kit/src/runtime/client/remote-functions/query-live/index.js
	packages/kit/src/runtime/client/remote-functions/query-live/instance.svelte.js
	packages/kit/src/runtime/client/remote-functions/query-live/proxy.js
	packages/kit/src/runtime/client/remote-functions/query-live/cache.js
	packages/kit/src/runtime/client/remote-functions/query-live/iterator.js
	packages/kit/src/runtime/client/remote-functions/query-live/proxy.svelte.spec.js
	packages/kit/src/runtime/client/remote-functions/cache.svelte.spec.js
	packages/kit/src/runtime/client/remote-functions/instance.unhandled.svelte.spec.js
	packages/kit/src/runtime/client/remote-functions/shared.transport.spec.js
	packages/kit/src/runtime/form-utils.js
	packages/kit/src/runtime/shared.js
	packages/kit/src/utils/shared-iterator.js
	packages/kit/types/index.d.ts
	documentation/docs/20-core-concepts/60-remote-functions.md
)

download_all() {
	local dir="$1"
	for file in "${FILES[@]}"; do
		mkdir -p "$dir/$(dirname "$file")"
		if ! curl -sf "$BASE_URL/$file" -o "$dir/$file"; then
			# a 404 usually means the file moved or was deleted upstream — that IS a change
			echo "MISSING $file (moved or deleted upstream?)" >&2
			rm -f "$dir/$file"
		fi
	done
}

hash_all() {
	local dir="$1"
	for file in "${FILES[@]}"; do
		if [[ -f "$dir/$file" ]]; then
			printf '%s %s\n' "$(sha256sum "$dir/$file" | cut -d' ' -f1)" "$file"
		else
			printf '%s %s\n' "missing" "$file"
		fi
	done
}

kit_version() {
	curl -sf https://registry.npmjs.org/@sveltejs/kit/latest |
		python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])'
}

case "$MODE" in
	download)
		download_all "$OUT_DIR"
		echo "downloaded to $OUT_DIR"
		;;

	baseline)
		download_all "$OUT_DIR"
		HASHES="$(hash_all "$OUT_DIR")"
		VERSION="$(kit_version)"
		printf '%s' "$HASHES" | python3 -c '
import datetime, json, sys
files = {}
for line in sys.stdin.read().strip().splitlines():
	digest, path = line.split(" ", 1)
	files[path] = digest
json.dump(
	{
		"kit_version": sys.argv[2],
		"checked_at": datetime.date.today().isoformat(),
		"files": files
	},
	open(sys.argv[1], "w"),
	indent="\t"
)
print(f"baseline.json updated (kit {sys.argv[2]}, {len(files)} files)")
' "$BASELINE" "$VERSION"
		;;

	check)
		download_all "$OUT_DIR"
		HASHES="$(hash_all "$OUT_DIR")"
		VERSION="$(kit_version)"
		printf '%s' "$HASHES" | python3 -c '
import json, sys
baseline = json.load(open(sys.argv[1]))
baseline_version = baseline["kit_version"]
print(f"kit version: baseline={baseline_version} latest={sys.argv[2]}")
old_files = baseline["files"]
current = {}
for line in sys.stdin.read().strip().splitlines():
	digest, path = line.split(" ", 1)
	current[path] = digest
changed = []
for path, digest in current.items():
	old = old_files.get(path)
	if old is None:
		changed.append(f"NEW      {path}")
	elif old != digest:
		label = "MISSING " if digest == "missing" else "CHANGED "
		changed.append(f"{label} {path}")
for path in old_files:
	if path not in current:
		changed.append(f"REMOVED  {path}")
if changed:
	print("\n".join(changed))
	print(f"\n{len(changed)} tracked upstream file(s) differ from baseline")
	sys.exit(1)
print("no upstream changes in tracked files")
' "$BASELINE" "$VERSION"
		;;

	*)
		echo "unknown mode: $MODE (use check | baseline | download)" >&2
		exit 2
		;;
esac
