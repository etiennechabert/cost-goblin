#!/usr/bin/env bash
#
# Pack scripts/gcp-focus-exporter into gcp-focus-exporter.tar.gz, the release
# asset the exporter README and costgoblin.com download into Cloud Shell:
#
#   curl -fsSL https://github.com/etiennechabert/cost-goblin/releases/latest/download/gcp-focus-exporter.tar.gz | tar xz
#
# An "Open in Cloud Shell" link can only clone the whole repository, which is
# ~30 MB of history for a ~50 KB folder.
#
# Packs HEAD, not the working tree: committed files only, with their committed
# modes (deploy.sh stays executable), under one gcp-focus-exporter/ folder and
# dated to the commit, so a re-run builds the same bytes. The tests stay out:
# deploying needs none of them.
#
#   bash .github/scripts/pack-gcp-exporter.sh <output.tar.gz>
#
set -euo pipefail

out="${1:?usage: pack-gcp-exporter.sh <output.tar.gz>}"
case "${out}" in
  /*) ;;
  *) out="${PWD}/${out}" ;;
esac

# The exclude pathspec is resolved against the working directory, so run from
# the repository root wherever the caller is.
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

git archive --format=tar.gz --prefix=gcp-focus-exporter/ \
  --mtime="$(git log -1 --format=%cI HEAD)" --output="${out}" \
  HEAD:scripts/gcp-focus-exporter -- ':(exclude)*.test.mjs'
