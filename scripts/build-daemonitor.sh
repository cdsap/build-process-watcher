#!/usr/bin/env bash
set -euo pipefail

commit="${1:?Usage: build-daemonitor.sh <full-source-commit> <output-bin-dir>}"
output="${2:?Missing output-bin-dir}"
if [[ ! "$commit" =~ ^[a-f0-9]{40}$ ]]; then
  echo 'Daemonitor source must be pinned to a full commit SHA' >&2
  exit 2
fi
mkdir -p "$output"
output="$(cd "$output" && pwd)"
source_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/bpw-daemonitor-source.XXXXXX")"
trap 'rm -rf "$source_dir"' EXIT
git -C "$source_dir" init --quiet
git -C "$source_dir" fetch --quiet --depth 1 https://github.com/cdsap/daemonitor.git "$commit"
git -C "$source_dir" checkout --quiet --detach FETCH_HEAD
test "$(git -C "$source_dir" rev-parse HEAD)" = "$commit"
(
  cd "$source_dir/cored"
  go build -trimpath -o "$output/" ./cmd/daemonitor-cli ./cmd/daemonitor-cored
)
python3 - "$output" "$commit" <<'PY'
import hashlib, json, pathlib, sys
directory = pathlib.Path(sys.argv[1])
info = {
    'source_commit': sys.argv[2], 'release': False,
    'binary_sha256': {name: hashlib.sha256((directory / name).read_bytes()).hexdigest()
                      for name in ['daemonitor-cli', 'daemonitor-cored']},
}
(directory / 'build-info.json').write_text(json.dumps(info, indent=2) + '\n')
PY
