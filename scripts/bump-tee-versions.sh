#!/usr/bin/env bash
#
# bump-tee-versions.sh — StealthWage addition, not part of the upstream scaffold.
#
# WHY THIS EXISTS
# The scaffold's main branch pins tee-node v0.0.21 / tee-proxy v0.0.18. Flare
# DevRel's pinned Telegram post (2026-08-01) says Coston2 requires
# tee-node >= v0.0.22: older nodes get EVERY data-provider vote rejected, so the
# proxy queue stays empty forever with no error. That is the "machine is
# PRODUCTION, tunnel alive, zero instructions delivered" failure other teams are
# stuck on. It is silent — nothing logs a version mismatch.
#
# Three pins are coupled and scripts/check-versions.sh fails the build if they
# drift: go/go.mod, tools/go.mod (tee-node + tee-proxy), proxy/Dockerfile ARG.
#
# Tags are used rather than the develop branch deliberately: post-build.sh
# allowlists a TEE code-version HASH on-chain. A moving branch changes that hash
# on every rebuild and silently invalidates the allowlist entry. If votes are
# still rejected on the latest tag, THEN try develop as DevRel suggested.
#
# Requires Docker (uses the golang image so no local Go toolchain is needed).
# Usage: ./scripts/bump-tee-versions.sh [tee-node-tag] [tee-proxy-tag]
set -euo pipefail

TEE_NODE_TAG="${1:-v0.0.24}"
TEE_PROXY_TAG="${2:-v0.0.21}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Toolchain floors (from each module's go directive):
#   tee-node   v0.0.22-v0.0.24 -> go 1.25.1   (scaffold's pinned images are fine,
#                                              so the TEE code hash is unaffected)
#   tee-proxy  v0.0.19         -> go 1.25.1
#   tee-proxy  v0.0.20-v0.0.21 -> go 1.25.8   (needs a newer proxy builder image)
#
# GOTOOLCHAIN=auto lets the container fetch whatever toolchain a module demands,
# instead of dying with "requires go >= X (running go Y; GOTOOLCHAIN=local)".
GO_IMAGE="${GO_IMAGE:-golang:1.25.1}"
PROXY_BUILDER_IMAGE="${PROXY_BUILDER_IMAGE:-golang:1.25.8-alpine}"

echo "[bump] tee-node -> ${TEE_NODE_TAG}, tee-proxy -> ${TEE_PROXY_TAG}"

command -v docker >/dev/null || { echo "[bump] ERROR: Docker required" >&2; exit 1; }

# go get inside a container so go.sum is regenerated correctly. Hand-editing
# go.mod without updating go.sum produces a build that fails much later, inside
# the Docker image build, with an opaque checksum error.
run_go() {
    local workdir="$1"; shift
    docker run --rm \
        -e GOTOOLCHAIN=auto \
        -v "${PROJECT_DIR}:/src" \
        -v "${HOME}/.cache/go-build:/root/.cache/go-build" \
        -v "${HOME}/go/pkg/mod:/go/pkg/mod" \
        -w "/src/${workdir}" \
        "${GO_IMAGE}" "$@"
}

echo "[bump] updating go/go.mod"
run_go go go get "github.com/flare-foundation/tee-node@${TEE_NODE_TAG}"
run_go go go mod tidy

echo "[bump] updating tools/go.mod"
run_go tools go get "github.com/flare-foundation/tee-node@${TEE_NODE_TAG}"
run_go tools go get "github.com/flare-foundation/tee-proxy@${TEE_PROXY_TAG}"
run_go tools go mod tidy

echo "[bump] updating proxy/Dockerfile (ARG + builder image)"
# BSD sed (macOS) needs the empty -i argument; GNU sed does not.
sed_i() { if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi; }

sed_i "s/^ARG TEE_PROXY_VERSION=.*/ARG TEE_PROXY_VERSION=${TEE_PROXY_TAG}/" "${PROJECT_DIR}/proxy/Dockerfile"

# Only the PROXY builder moves. The ext-proxy runs on the host, so its image is
# not attested and its hash is not allowlisted on-chain — safe to bump. Never
# touch go/Dockerfile or docker/node-base.Dockerfile for this reason: those
# build the TEE node, and a changed base invalidates the allowlisted code hash.
sed_i "s|^FROM golang:[^ ]* AS builder|FROM ${PROXY_BUILDER_IMAGE} AS builder|" "${PROJECT_DIR}/proxy/Dockerfile"

echo "[bump] verifying pins agree"
"${SCRIPT_DIR}/check-versions.sh"

echo "[bump] done. Rebuild images before re-registering:"
echo "         ./scripts/build-node-base.sh && docker compose build --no-cache"
echo "       A new code hash means you MUST re-run post-build.sh to allowlist it."
