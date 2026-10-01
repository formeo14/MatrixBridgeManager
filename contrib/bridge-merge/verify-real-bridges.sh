#!/usr/bin/env bash
set -euo pipefail

: "${PG_ADMIN_URI:?Set PG_ADMIN_URI to a PostgreSQL superuser URI for a disposable server}"
VERSION="${BRIDGE_VERSION:-v0.2609.0}"
declare -A HASHES=(
  [whatsapp]=fb12e322ce536bc110a6012afeeb371a7853f92df3845177dca39a5c595c2bd7
  [signal]=e4481d0abb0e8cd98eba54d3d42e119cd2bd03faac3885c544286e602b5f7b06
)
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$WORK"' EXIT

for net in whatsapp signal; do
  bin="$WORK/mautrix-$net"
  curl -fsSL "https://github.com/mautrix/$net/releases/download/$VERSION/mautrix-$net-amd64" -o "$bin"
  echo "${HASHES[$net]}  $bin" | sha256sum -c -
  chmod +x "$bin"
  db="real_${net}_$$"
  psql "$PG_ADMIN_URI" -qc "CREATE DATABASE $db"
  pg_uri="$(python3 -c "import sys,urllib.parse as u; p=u.urlparse(sys.argv[1]); print(p._replace(path='/'+sys.argv[2]).geturl())" "$PG_ADMIN_URI" "$db")"
  "$bin" -e -c "$WORK/$net-base.yaml" >/dev/null
  for kind in sqlite postgres; do
    python3 - "$WORK/$net-base.yaml" "$WORK/$net-$kind.yaml" "$kind" "$WORK/$net.db" "$pg_uri" <<'PY'
import sys, yaml
source, target, kind, path, uri = sys.argv[1:]
config = yaml.safe_load(open(source))
config["homeserver"].update(address="http://127.0.0.1:1", domain="bridge.test")
config["appservice"].update(as_token="a" * 64, hs_token="h" * 64)
config["appservice"]["port"] += 1 if kind == "postgres" else 0
config["bridge"]["permissions"] = {"bridge.test": "admin"}
config["database"] = (
    {"type": "sqlite3-fk-wal", "uri": f"file:{path}?_txlock=immediate"}
    if kind == "sqlite"
    else {"type": "postgres", "uri": uri + "?sslmode=disable"}
)
yaml.safe_dump(config, open(target, "w"))
PY
    "$bin" -n -c "$WORK/$net-$kind.yaml" >"$WORK/$net-$kind.log" 2>&1 &
  done
  sleep 5
  (cd "$ROOT" && BRIDGE_MERGE_REAL_BRIDGE_ID="$net" BRIDGE_MERGE_REAL_SQLITE="$WORK/$net.db" \
    BRIDGE_MERGE_REAL_POSTGRES="$pg_uri" \
    pnpm exec vitest --config vitest.unit.config.ts run tests/bridgeManagement/RealBridgeDatabase.spec.ts)
  kill $(jobs -p)
  wait 2>/dev/null || true
  psql "$PG_ADMIN_URI" -qc "DROP DATABASE $db WITH (FORCE)"
done
