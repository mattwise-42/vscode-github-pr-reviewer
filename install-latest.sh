#!/usr/bin/env bash
set -euo pipefail

repo="mattwise-42/vscode-github-pr-reviewer"

if ! command -v curl >/dev/null 2>&1; then
  printf 'curl is required to install GitHub PR Reviewer.\n' >&2
  exit 1
fi

if ! command -v code >/dev/null 2>&1; then
  printf 'The VS Code CLI (code) must be available in PATH.\n' >&2
  exit 1
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

latest_url="https://github.com/$repo/releases/latest"
release_url="$(curl --fail --silent --show-error --location --output /dev/null --write-out '%{url_effective}' "$latest_url")"

if [[ "$release_url" != */releases/tag/v* ]]; then
  printf 'Could not determine the latest GitHub PR Reviewer release.\n' >&2
  exit 1
fi

version="${release_url##*/releases/tag/v}"
asset="github-pr-reviewer-${version}.vsix"
asset_path="$tmpdir/$asset"
download_url="https://github.com/$repo/releases/download/v${version}/${asset}"

curl --fail --silent --show-error --location "$download_url" --output "$asset_path"
code --install-extension "$asset_path" --force
printf 'Installed GitHub PR Reviewer %s.\n' "$version"
