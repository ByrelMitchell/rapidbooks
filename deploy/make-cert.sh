#!/usr/bin/env bash
# Make a small private certificate authority (CA) and a server certificate for
# RapidBooks, so the app can be served over HTTPS on the LAN.
#
#   sudo ./deploy/make-cert.sh [host-name] [lan-ip] [output-dir]
#
# Defaults: this machine's host name, its first LAN address, /etc/rapidbooks/tls.
# Re-running keeps the existing CA (so clients that trust it keep working) and makes
# a new server certificate. Then:
#   - in /etc/rapidbooks.env set
#       RAPIDBOOKS_TLS_CERT=<output-dir>/server.crt
#       RAPIDBOOKS_TLS_KEY=<output-dir>/server.key
#   - copy <output-dir>/rapidbooks-ca.crt to every client and trust it (docs/DEPLOY.md)
set -euo pipefail

HOST_NAME="${1:-$(hostname -f 2>/dev/null || hostname)}"
LAN_IP="${2:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
OUT="${3:-/etc/rapidbooks/tls}"
DAYS_CA=3650
DAYS_SERVER=825

command -v openssl >/dev/null || { echo "openssl is not installed." >&2; exit 1; }
[ -n "$HOST_NAME" ] || { echo "Give the server's host name: $0 <host-name> <lan-ip>" >&2; exit 2; }

mkdir -p "$OUT"
chmod 0755 "$OUT"
cd "$OUT"

if [ ! -f rapidbooks-ca.key ] || [ ! -f rapidbooks-ca.crt ]; then
  echo "Creating the RapidBooks CA in $OUT"
  openssl req -x509 -new -nodes -newkey rsa:3072 -sha256 -days "$DAYS_CA" \
    -keyout rapidbooks-ca.key -out rapidbooks-ca.crt \
    -subj "/CN=RapidBooks Local CA ($HOST_NAME)" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"
  chmod 0600 rapidbooks-ca.key
else
  echo "Keeping the existing CA in $OUT"
fi

SAN="DNS:$HOST_NAME,DNS:localhost,IP:127.0.0.1"
SHORT="${HOST_NAME%%.*}"
[ "$SHORT" != "$HOST_NAME" ] && SAN="$SAN,DNS:$SHORT"
[ -n "$LAN_IP" ] && SAN="$SAN,IP:$LAN_IP"

cat > server.ext <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$SAN
EOF

echo "Creating the server certificate for: $SAN"
openssl req -new -nodes -newkey rsa:2048 -sha256 -keyout server.key -out server.csr -subj "/CN=$HOST_NAME"
openssl x509 -req -in server.csr -CA rapidbooks-ca.crt -CAkey rapidbooks-ca.key -CAcreateserial \
  -out server.crt -days "$DAYS_SERVER" -sha256 -extfile server.ext
rm -f server.csr server.ext

# The server key must be readable by the service user, not by everyone.
if id rapidbooks >/dev/null 2>&1; then
  chown root:rapidbooks server.key server.crt
  chmod 0640 server.key
else
  chmod 0600 server.key
fi
chmod 0644 server.crt rapidbooks-ca.crt

cat <<EOF

Done. Files in $OUT:
  rapidbooks-ca.crt   the CA certificate: install this on every client computer
  rapidbooks-ca.key   the CA's private key: keep it here, never copy it anywhere
  server.crt/.key     the server's certificate and key

Next:
  1. In /etc/rapidbooks.env:
       RAPIDBOOKS_TLS_CERT=$OUT/server.crt
       RAPIDBOOKS_TLS_KEY=$OUT/server.key
  2. sudo systemctl restart rapidbooks
  3. On each client, trust $OUT/rapidbooks-ca.crt (see docs/DEPLOY.md, "HTTPS"),
     and open https://$HOST_NAME:PORT/
EOF
