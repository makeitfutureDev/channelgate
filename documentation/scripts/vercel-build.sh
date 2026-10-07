#!/usr/bin/env bash
# Vercel's website project runs this after receiving its existing static source.
# Build documentation from the public source without adding that checkout to the site output.
set -euo pipefail
website_output="$PWD"
docs_source_ref="${CHANNELGATE_DOCS_REF:-beta}"
docs_build_directory="$(mktemp -d /tmp/channelgate-docs.XXXXXX)"
trap 'rm -rf "$docs_build_directory"' EXIT

git clone --depth 1 --branch "$docs_source_ref" https://github.com/makeitfutureDev/channelgate.git "$docs_build_directory"
npm --prefix "$docs_build_directory/documentation" ci --no-fund --no-audit
npm --prefix "$docs_build_directory/documentation" run build
npm --prefix "$docs_build_directory/documentation" run export -- --output "$website_output"
