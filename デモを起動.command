#!/bin/zsh

set -eu

PROJECT_DIR=${0:A:h}
DEMO_URL="http://localhost:4173/"

cd "$PROJECT_DIR"

if /usr/bin/curl -fsS --max-time 1 "$DEMO_URL" >/dev/null 2>&1; then
  /usr/bin/open "$DEMO_URL"
  exit 0
fi

(
  attempt=0
  while (( attempt < 40 )); do
    if /usr/bin/curl -fsS --max-time 1 "$DEMO_URL" >/dev/null 2>&1; then
      /usr/bin/open "$DEMO_URL"
      exit 0
    fi
    attempt=$(( attempt + 1 ))
    /bin/sleep 0.25
  done
  echo "ブラウザを自動で開けませんでした。$DEMO_URL を手動で開いてください。"
) &

echo "みちのーと｜放課後のあゆみ を起動します。"
echo "デモ中はこのターミナルを閉じないでください。終了するときは Control + C を押します。"
exec /usr/bin/env python3 scripts/serve.py --port 4173
