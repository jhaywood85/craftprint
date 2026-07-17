#!/bin/bash
# Double-click me to play CraftPrint on this Mac — and to put it on the iPad.
cd "$(dirname "$0")"

PORT=4173

# Find this Mac's address on the local network, so you can open the game on
# the iPad (same Wi-Fi) and "Add to Home Screen".
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)"

echo "🧱 CraftPrint is running!"
echo
echo "   On this Mac:   http://localhost:$PORT"
if [ -n "$LAN_IP" ]; then
  echo "   On the iPad:   http://$LAN_IP:$PORT   (same Wi-Fi, open in Safari)"
  echo "                  then Share → Add to Home Screen"
else
  echo "   On the iPad:   connect to Wi-Fi, then use this Mac's IP address on port $PORT"
fi
echo
echo "   Close this window to stop the game."
echo

( sleep 1 && open "http://localhost:$PORT" ) &
exec python3 -m http.server "$PORT"
