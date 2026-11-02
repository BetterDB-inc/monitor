#!/usr/bin/env bash
# Generate a throwaway PKI for the mutual-TLS e2e (apps/api/test/mtls.e2e-spec.ts):
#   ca.crt / ca.key          private CA
#   server.crt / server.key  Valkey server cert, CN=localhost, SAN localhost + 127.0.0.1
#   client.crt / client.key  client cert whose CN maps to the ACL user `monitor-mtls`
#   client-enc.key           same client key, PKCS#8-encrypted with passphrase `e2e-passphrase`
#   stranger.crt / .key      client cert with a CN that maps to no ACL user
# Keys are world-readable on purpose: the Valkey container reads them through a
# bind mount, and nothing here is a real secret (certs live 2 days).
set -euo pipefail
OUT="${1:?usage: mtls-e2e-certs.sh <out-dir>}"
mkdir -p "$OUT"
cd "$OUT"

openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 2 \
  -subj "/CN=BetterDB mTLS e2e CA" >/dev/null 2>&1

issue() { # name subject extensions
  openssl req -newkey rsa:2048 -nodes -keyout "$1.key" -out "$1.csr" -subj "$2" >/dev/null 2>&1
  openssl x509 -req -in "$1.csr" -CA ca.crt -CAkey ca.key -CAcreateserial -out "$1.crt" -days 2 \
    -extfile <(printf '%b' "$3") >/dev/null 2>&1
}

issue server "/CN=localhost" "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth"
issue client "/CN=monitor-mtls" "extendedKeyUsage=clientAuth"
issue stranger "/CN=stranger" "extendedKeyUsage=clientAuth"
openssl pkey -in client.key -aes256 -passout pass:e2e-passphrase -out client-enc.key

chmod 644 ./*.key
rm -f ./*.csr ./*.srl
echo "mTLS e2e certificates written to $OUT"
