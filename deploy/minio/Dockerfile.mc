# syntax=docker/dockerfile:1.7

# MinIO client (mc) for the one-shot `storage-iam` service (PROD-302, D-051): creates the least-privilege users and
# policies of the attachments bucket. Like the server image, the published binary image is no longer available from a
# public registry, so it is built from the official source, pinned by revision and archive checksum, with the
# upstream license and source kept in the image. The image holds only mc and the IAM script; it never runs as a service.
FROM golang:1.26-alpine AS builder

WORKDIR /src
ADD --checksum=sha256:95cd293c7119f16921a6dc515a1fb74a2227f19fd994b9c8b770a154e802ac44 \
    https://codeload.github.com/minio/mc/tar.gz/7394ce0dd2a80935aded936b09fa12cbb3cb8096 /tmp/mc-source.tar.gz
# Same vulnerable-module bumps as deploy/minio/Dockerfile (Trivy HIGH/CRITICAL with a fix), within the majors mc uses.
RUN tar -xzf /tmp/mc-source.tar.gz --strip-components=1 \
    && GOTOOLCHAIN=local go get \
      github.com/prometheus/prometheus@v0.311.3 \
      golang.org/x/crypto@v0.57.0 \
      golang.org/x/net@v0.60.0 \
      google.golang.org/grpc@v1.83.2 \
    && CGO_ENABLED=0 GOTOOLCHAIN=local go build -mod=mod -trimpath -o /out/mc . \
    && tar -czf /out/source.tar.gz .

FROM alpine:3.23

RUN apk add --no-cache ca-certificates
COPY --from=builder /out/mc /usr/local/bin/mc
COPY --from=builder /src/LICENSE /usr/share/licenses/mc/LICENSE
COPY --from=builder /out/source.tar.gz /usr/share/mc/source.tar.gz
COPY deploy/minio/Dockerfile.mc /usr/share/mc/Dockerfile.mc
COPY deploy/minio/iam.sh /usr/local/bin/cvg-storage-iam
COPY deploy/minio/iam-verify.sh /usr/local/bin/cvg-storage-iam-verify

LABEL org.opencontainers.image.source="https://github.com/minio/mc" \
      org.opencontainers.image.revision="7394ce0dd2a80935aded936b09fa12cbb3cb8096" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

USER 1000:1000
ENV HOME=/tmp
ENTRYPOINT ["/bin/sh", "/usr/local/bin/cvg-storage-iam"]
