#!/usr/bin/env bash
# render-formula.sh — render Homebrew Formula/mono.rb for a given release tag.
#
# Downloads SHA256SUMS from the release and emits a complete formula to stdout.
#
# Usage:
#   bash scripts/render-formula.sh v0.3.0 > Formula/mono.rb
#
# Env overrides:
#   MONO_REPO  owner/repo on GitHub (default: ilies-bel/mono)

set -euo pipefail

REPO="${MONO_REPO:-ilies-bel/mono}"
TAG="${1:-}"
[ -n "$TAG" ] || { echo "usage: $0 <tag>" >&2; exit 2; }

VERSION="${TAG#v}"
BASE="https://github.com/${REPO}/releases/download/${TAG}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsSL "${BASE}/SHA256SUMS" -o "${TMP}/SHA256SUMS"

sha_for() {
  local asset="$1"
  local sha
  sha="$(grep -E "[[:space:]]${asset}\$" "${TMP}/SHA256SUMS" | awk '{print $1}' | head -n1)"
  [ -n "$sha" ] || { echo "x no checksum for ${asset} in ${BASE}/SHA256SUMS" >&2; exit 1; }
  printf '%s\n' "$sha"
}

DARWIN_ARM64_SHA="$(sha_for mono-darwin-arm64)"
DARWIN_X64_SHA="$(sha_for mono-darwin-x64)"
LINUX_ARM64_SHA="$(sha_for mono-linux-arm64)"
LINUX_X64_SHA="$(sha_for mono-linux-x64)"

cat <<RUBY
class Mono < Formula
  desc "Monorepo-style git orchestration across parent + d2r2 submodules"
  homepage "https://github.com/${REPO}"
  version "${VERSION}"
  license :cannot_represent

  on_macos do
    on_arm do
      url "${BASE}/mono-darwin-arm64"
      sha256 "${DARWIN_ARM64_SHA}"

      def install
        bin.install "mono-darwin-arm64" => "mono"
      end
    end
    on_intel do
      url "${BASE}/mono-darwin-x64"
      sha256 "${DARWIN_X64_SHA}"

      def install
        bin.install "mono-darwin-x64" => "mono"
      end
    end
  end

  on_linux do
    on_arm do
      url "${BASE}/mono-linux-arm64"
      sha256 "${LINUX_ARM64_SHA}"

      def install
        bin.install "mono-linux-arm64" => "mono"
      end
    end
    on_intel do
      url "${BASE}/mono-linux-x64"
      sha256 "${LINUX_X64_SHA}"

      def install
        bin.install "mono-linux-x64" => "mono"
      end
    end
  end

  test do
    assert_match "${VERSION}", shell_output("#{bin}/mono --version")
  end
end
RUBY
