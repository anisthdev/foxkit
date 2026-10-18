#!/bin/sh
# Register the native messaging host with Firefox (per user).
set -eu

dir=$(cd "$(dirname "$0")" && pwd)
target="$HOME/.mozilla/native-messaging-hosts"

chmod +x "$dir/foxkit_host.py"
mkdir -p "$target"
cat >"$target/foxkit.json" <<EOF
{
  "name": "foxkit",
  "description": "foxkit native helper",
  "path": "$dir/foxkit_host.py",
  "type": "stdio",
  "allowed_extensions": ["foxkit@asif"]
}
EOF
echo "Installed $target/foxkit.json"
