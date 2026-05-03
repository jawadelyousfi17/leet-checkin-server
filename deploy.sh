#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

APP_NAME="leet-chekin"

echo "[deploy] git pull"
git pull --ff-only

echo "[deploy] npm install"
npm install

echo "[deploy] prisma generate"
npx prisma generate

echo "[deploy] npm run build"
npm run build

if pm2 describe "$APP_NAME" > /dev/null 2>&1; then
  echo "[deploy] pm2 restart $APP_NAME"
  pm2 restart "$APP_NAME" --update-env
else
  echo "[deploy] pm2 start dist/index.js --name $APP_NAME"
  pm2 start dist/index.js --name "$APP_NAME"
fi

pm2 save > /dev/null

echo "[deploy] done"
