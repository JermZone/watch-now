VERSION ?= $(shell node -p "require('./frontend/package.json').version")
export NOW_BUILD_VERSION := $(VERSION)
.PHONY: test build docker-build check-release

test:
	go test ./...
	go vet ./...
	cd frontend && npm test
	python3 scripts/test-latest-image.py
	python3 scripts/test-release-consistency.py

check-release:
	python3 scripts/test-compose.py
	python3 scripts/test-latest-image.py
	python3 scripts/test-release-consistency.py

build:
	cd frontend && npm run build
	go build -trimpath -ldflags="-X main.version=$(VERSION)" ./cmd/watch-now

docker-build:
	docker build --build-arg VERSION=$(VERSION) --tag watch-now:$(VERSION) .
