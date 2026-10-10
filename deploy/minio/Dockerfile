# syntax=docker/dockerfile:1.7

# The official binary image was removed from its public registry. Build the
# official source, pinned by revision and archive checksum, rather than depend
# on an unreviewed mirror. Keep the upstream license and source in the image.
FROM golang:1.26-alpine AS builder

WORKDIR /src
ADD --checksum=sha256:71794c2df26aad0cc99e8421c58b7aa2dd55969f979b0e7d1e931042e9fabcd6 \
    https://codeload.github.com/minio/minio/tar.gz/7aac2a2c5b7c882e68c1ce017d8256be2feea27f /tmp/minio-source.tar.gz
RUN tar -xzf /tmp/minio-source.tar.gz --strip-components=1 \
    && GOTOOLCHAIN=local go get \
      github.com/apache/thrift@v0.24.0 \
      github.com/buger/jsonparser@v1.1.2 \
      github.com/go-jose/go-jose/v4@v4.1.4 \
      github.com/prometheus/prometheus@v0.311.3 \
      github.com/rabbitmq/amqp091-go@v1.13.0 \
      golang.org/x/crypto@v0.57.0 \
      golang.org/x/net@v0.60.0 \
      google.golang.org/grpc@v1.83.2 \
    && CGO_ENABLED=0 GOTOOLCHAIN=local go build -mod=mod -trimpath -o /out/minio . \
    && tar -czf /out/source.tar.gz .

FROM alpine:3.23

RUN apk add --no-cache ca-certificates curl
COPY --from=builder /out/minio /usr/local/bin/minio
COPY --from=builder /src/LICENSE /usr/share/licenses/minio/LICENSE
COPY --from=builder /out/source.tar.gz /usr/share/minio/source.tar.gz
COPY deploy/minio/Dockerfile /usr/share/minio/Dockerfile

LABEL org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.revision="7aac2a2c5b7c882e68c1ce017d8256be2feea27f" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

VOLUME ["/data"]
EXPOSE 9000 9001
ENTRYPOINT ["/usr/local/bin/minio"]
CMD ["server", "/data"]
