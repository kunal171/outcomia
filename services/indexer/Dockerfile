# syntax=docker/dockerfile:1

FROM rust:1.97.1-bookworm AS builder

WORKDIR /build

# Copy the independent indexer workspace, including migrations embedded by SQLx.
COPY Cargo.toml Cargo.lock ./
COPY migrations ./migrations
COPY src ./src

RUN cargo build --locked --release


FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd \
        --system \
        --uid 10001 \
        --create-home \
        --home-dir /home/outcomia \
        outcomia

COPY --from=builder \
    /build/target/release/outcomia-indexer \
    /usr/local/bin/outcomia-indexer

ENV HEALTH_ADDRESS=0.0.0.0:8080

EXPOSE 8080

USER 10001

STOPSIGNAL SIGTERM

ENTRYPOINT ["/usr/local/bin/outcomia-indexer"]
