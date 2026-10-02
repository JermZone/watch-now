# syntax=docker/dockerfile:1.7

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS frontend-builder
ARG VERSION=dev
ARG SOURCE_URL=https://github.com/JermZone/watch-now
ENV NOW_BUILD_VERSION=${VERSION}
ENV NOW_SOURCE_URL=${SOURCE_URL}
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM golang:1.27.1-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS server-builder
RUN apk add --no-cache ca-certificates
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
LABEL org.opencontainers.image.title="Watch Now" \
      org.opencontainers.image.description="A web player for Dispatcharr. Independent, open-source viewer companion." \
      org.opencontainers.image.source="https://github.com/JermZone/watch-now" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
COPY LICENSE /licenses/watch-now.txt
COPY THIRD_PARTY_NOTICES.md /licenses/THIRD_PARTY_NOTICES.md
COPY --from=frontend-builder /src/frontend/node_modules/react/LICENSE /licenses/react.txt
COPY --from=frontend-builder /src/frontend/node_modules/react-dom/LICENSE /licenses/react-dom.txt
COPY --from=frontend-builder /src/frontend/node_modules/mpegts.js/LICENSE /licenses/mpegts.js.txt
COPY --from=frontend-builder /src/frontend/node_modules/es6-promise/LICENSE /licenses/es6-promise.txt
COPY --from=frontend-builder /src/frontend/node_modules/webworkify-webpack/README.md /licenses/webworkify-webpack-README.md
COPY --from=frontend-builder /src/frontend/node_modules/webworkify-webpack/package.json /licenses/webworkify-webpack-package.json
COPY --from=frontend-builder /src/frontend/node_modules/scheduler/LICENSE /licenses/scheduler.txt
COPY --from=server-builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=server-builder /out/watch-now /watch-now
COPY --from=frontend-builder /src/frontend/dist /web
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/watch-now", "healthcheck"]
ENTRYPOINT ["/watch-now"]
