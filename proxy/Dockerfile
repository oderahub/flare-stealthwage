# Self-contained build of tee-proxy. Clones tee-proxy from GitHub at build time
# so no local sibling repos are needed.
#
# TEE_PROXY_VERSION MUST stay aligned with the extension's Go-module pins
# (tools/go.mod): tee-proxy v0.0.21. tee-proxy's own go.mod transitively pins
# the matching tee-node and go-flare-common line, so building it with
# `go mod download` pulls the exact governance-aware node code the extension-tee
# image uses — no separate tee-node clone or replace directive is needed.
# Override via build arg when bumping both sides together.

ARG TEE_PROXY_VERSION=v0.0.21

# NOTE: not pinned by digest (unlike the main Dockerfile) — this is a dev convenience build.
# For full reproducibility, pin by digest: golang:1.25.8-alpine@sha256:...
# 1.25.8 (not 1.25.1) because tee-proxy >= v0.0.20 declares `go 1.25.8`.
# Only this builder may move: the ext-proxy runs on the host and is not
# attested, unlike go/Dockerfile and docker/node-base.Dockerfile whose image
# hash is allowlisted on-chain.
FROM golang:1.25.8-alpine AS builder

RUN apk add --no-cache git

ARG TEE_PROXY_VERSION

WORKDIR /app
RUN git clone --depth 1 --branch ${TEE_PROXY_VERSION} https://github.com/flare-foundation/tee-proxy.git

WORKDIR /app/tee-proxy
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux go build -a -o main ./cmd/proxy

# The example config moved between releases: repo root in <= v0.0.19,
# config/ in >= v0.0.21. Normalize to one path so a version bump doesn't break
# the COPY below with an opaque "not found" checksum error.
RUN cp config/config.example.toml /app/config.example.toml 2>/dev/null \
 || cp config.example.toml /app/config.example.toml

# Final stage
FROM alpine:3.21

WORKDIR /app

COPY --from=builder /app/tee-proxy/main .
COPY --from=builder /app/config.example.toml ./config/config.toml

RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 6661
EXPOSE 6662

CMD ["./main"]
