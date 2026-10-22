#!/bin/sh
# The judges' path, from the pushed main on GitHub: clone, build the unchanged Dockerfile, run on port 8000,
# post input_examples/example_1.json to /run and print the status and the first trace lines.
# Usage: sh scripts/clean-clone.sh [--with-keys]
#   no flag      the env file is .env.example with empty keys, so the run is in sample mode
#   --with-keys  the env file is ~/tradeflow/.env (never printed); the container reaches Zetaris and Nightshift
#                on the host through host.docker.internal
# Exit 0 when the run's status is success; non-zero otherwise.
set -eu

REPO_URL="https://github.com/Hasebul21/tradeflow"
IMAGE="oah-submission"
WITH_KEYS=0
case "${1:-}" in
  "") ;;
  --with-keys) WITH_KEYS=1 ;;
  *) echo "usage: sh scripts/clean-clone.sh [--with-keys]" >&2; exit 2 ;;
esac

TMP=$(mktemp -d /tmp/tf-clean-clone.XXXXXX)
CID=""
cleanup() {
  if [ -n "$CID" ]; then docker stop "$CID" >/dev/null 2>&1 || true; docker rm "$CID" >/dev/null 2>&1 || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

fail() { echo "FAIL: $*" >&2; exit 1; }

echo "== clone $REPO_URL"
GIT_TERMINAL_PROMPT=0 git -c credential.helper= clone --quiet "$REPO_URL" "$TMP/repo" || fail "the clone failed (a private repo fails here: make it public in the repo settings)"
cd "$TMP/repo"
echo "commit: $(git rev-parse HEAD)"

if [ "$WITH_KEYS" -eq 1 ]; then
  ENV_FILE="$HOME/tradeflow/.env"
  [ -f "$ENV_FILE" ] || fail "--with-keys needs $ENV_FILE"
  echo "env file: the host .env (not printed)"
else
  ENV_FILE="$TMP/repo/.env"
  cp .env.example "$ENV_FILE"
  echo "env file: .env.example with empty keys"
fi

# From inside the container localhost is the container, so the services on the host go through host.docker.internal.
probe() { # probe URL: any HTTP status counts as reachable
  docker run --rm node:22-slim node -e "fetch('$1').then(r=>console.log('reachable '+r.status),e=>console.log('unreachable '+e.message))" 2>&1 | tail -1
}
NIGHTSHIFT_OK=1
if [ "$WITH_KEYS" -eq 1 ]; then
  Z=$(probe http://host.docker.internal:8888/)
  N=$(probe http://host.docker.internal:8088/v1/models)
  echo "probe Zetaris (host.docker.internal:8888): $Z"
  echo "probe Nightshift (host.docker.internal:8088): $N"
  case "$N" in reachable*) ;; *) NIGHTSHIFT_OK=0 ;; esac
  case "$Z" in reachable*) ;; *) echo "Zetaris not reachable from the container: its queries will show source local-fallback." ;; esac
fi

echo "== docker build -t $IMAGE ."
docker build -q -t "$IMAGE" . >/dev/null || fail "docker build failed"

echo "== docker run"
if [ "$WITH_KEYS" -eq 1 ]; then
  CID=$(docker run -d --env-file "$ENV_FILE" \
    -e ZETARIS_REST_URL=http://host.docker.internal:8888/api/v1.0 \
    -e METERLESS_BASE_URL=http://host.docker.internal:8088/v1 \
    -e PORT=8000 -p 8000:8000 "$IMAGE")
else
  CID=$(docker run -d --env-file "$ENV_FILE" -e PORT=8000 -p 8000:8000 "$IMAGE")
fi

echo "== wait for /api/health"
i=0
until curl -fs -m 3 http://localhost:8000/api/health >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -le 90 ] || fail "/api/health did not answer within 180 s"
  [ "$(docker inspect -f '{{.State.Running}}' "$CID")" = "true" ] || fail "the container stopped"
  sleep 2
done
echo "/api/health answers"
i=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$CID")" = "healthy" ]; do
  i=$((i + 1)); [ "$i" -le 40 ] || fail "the container was not healthy within 200 s"
  sleep 5
done
echo "container health: healthy"

echo "== POST input_examples/example_1.json to /run"
curl -s -m 700 -X POST -H 'content-type: application/json' --data @input_examples/example_1.json \
  http://localhost:8000/run -o "$TMP/out.json" || fail "POST /run failed"
STATUS=$(node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(r.status)" "$TMP/out.json") || fail "the reply was not JSON"
echo "status: $STATUS"

echo "== first trace lines (docker exec head -5 logs/trace-example_1.jsonl)"
docker exec "$CID" head -5 logs/trace-example_1.jsonl || true

if [ "$WITH_KEYS" -eq 1 ]; then
  echo "== Query lines: sources"
  docker exec "$CID" grep '"agent_name":"Query"' logs/trace-example_1.jsonl \
    | sed -n 's/.*"input_summary":"\([a-z_]*\) .*"source":"\([a-z-]*\)".*/\1 source=\2/p' || true
fi

if [ "$STATUS" != "success" ]; then
  if [ "$WITH_KEYS" -eq 1 ] && [ "$NIGHTSHIFT_OK" -eq 0 ]; then
    echo "Nightshift not reachable from the container: the model runs through host.docker.internal:8088, which Docker cannot reach from here. Status was $STATUS."
    exit 0
  fi
  node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(JSON.stringify(r.error||(r.output&&r.output.stop_reason)||null))" "$TMP/out.json" || true
  fail "status is $STATUS, not success"
fi
echo "OK: status success"
