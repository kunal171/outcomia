# syntax=docker/dockerfile:1

FROM rust:1.97.1-bookworm AS builder

WORKDIR /build/services/indexer

# Copy the independent indexer workspace, including migrations embedded by SQLx.
COPY services/indexer/Cargo.toml services/indexer/Cargo.lock ./
COPY services/indexer/migrations ./migrations
COPY services/indexer/src ./src
COPY app/idl/outcomia.json /build/app/idl/outcomia.json
# Earlier deployed IDLs: history and unmigrated accounts decode with them.
COPY app/idl/history /build/app/idl/history

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
    /build/services/indexer/target/release/outcomia-indexer \
    /usr/local/bin/outcomia-indexer

ENV HEALTH_ADDRESS=0.0.0.0:8080

ENV API_ADDRESS=0.0.0.0:8081

EXPOSE 8080 8081

USER 10001

STOPSIGNAL SIGTERM

ENTRYPOINT ["/usr/local/bin/outcomia-indexer"]
