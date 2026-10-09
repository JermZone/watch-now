# syntax=docker/dockerfile:1.7

FROM node:26.10.0-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS frontend-builder
ARG VERSION=dev
ARG SOURCE_URL=https://github.com/JermZone/watch-now
ENV NOW_BUILD_VERSION=${VERSION}
ENV NOW_SOURCE_URL=${SOURCE_URL}
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM golang:1.27.2-alpine@sha256:85dc1069ac644ea3c527b177303a406eb3358192816cd7f9e5848eb658851673 AS server-builder
RUN apk add --no-cache ca-certificates
RUN mkdir -p /out/share-root/watch-now && chown 65532:65532 /out/share-root/watch-now && chmod 0700 /out/share-root/watch-now
WORKDIR /src
COPY go.mod ./
COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN go test ./...
ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags="-s -w -X main.version=${VERSION}" \
    -o /out/watch-now \
    ./cmd/watch-now

FROM scratch
ARG VERSION=dev
ARG REVISION=unknown
ARG SOURCE_URL=https://github.com/JermZone/watch-now
LABEL org.opencontainers.image.title="Watch Now" \
      org.opencontainers.image.description="A web player for Dispatcharr. Independent, open-source viewer companion." \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
COPY LICENSE /licenses/watch-now.txt
COPY THIRD_PARTY_NOTICES.md /licenses/THIRD_PARTY_NOTICES.md
COPY --from=frontend-builder /src/frontend/node_modules/react/LICENSE /licenses/react.txt
COPY --from=frontend-builder /src/frontend/node_modules/react-dom/LICENSE /licenses/react-dom.txt
COPY --from=frontend-builder /src/frontend/node_modules/mpegts.js/LICENSE /licenses/mpegts.js.txt
COPY --from=frontend-builder /src/frontend/node_modules/hls.js/LICENSE /licenses/hls.js.txt
COPY --from=frontend-builder /src/frontend/node_modules/es6-promise/LICENSE /licenses/es6-promise.txt
COPY --from=frontend-builder /src/frontend/node_modules/events/LICENSE /licenses/events.txt
COPY --from=frontend-builder /src/frontend/node_modules/scheduler/LICENSE /licenses/scheduler.txt
COPY --from=frontend-builder /src/frontend/node_modules/media-chrome/LICENSE /licenses/media-chrome.txt
COPY --from=frontend-builder /src/frontend/node_modules/ce-la-react/LICENSE /licenses/ce-la-react.txt
COPY --from=server-builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=server-builder /out/watch-now /watch-now
# Copy the parent so the private directory itself is present in the layer. Docker
# storage drivers can differ in permissions assigned to a newly created target.
COPY --from=server-builder --chown=65532:65532 /out/share-root/ /var/lib/
COPY --from=frontend-builder /src/frontend/dist /web
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/watch-now", "healthcheck"]
ENTRYPOINT ["/watch-now"]
