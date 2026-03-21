#!/bin/sh
set -eu

escape_js() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

APP_NAME="${POWERUP_APP_NAME:-ClearOps Card Nesting}"
API_KEY="${POWERUP_API_KEY:-REPLACE_WITH_TRELLO_API_KEY}"
APP_URL="${POWERUP_APP_URL:-https://your-powerup-domain.example.com}"

APP_NAME_ESCAPED="$(escape_js "$APP_NAME")"
API_KEY_ESCAPED="$(escape_js "$API_KEY")"
APP_URL_ESCAPED="$(escape_js "$APP_URL")"

cat > /usr/share/nginx/html/config.js <<EOF
window.POWERUP_CONFIG = {
  appName: "$APP_NAME_ESCAPED",
  apiKey: "$API_KEY_ESCAPED",
  appUrl: "$APP_URL_ESCAPED"
};
EOF
