#!/usr/bin/env bash
# Makes the key that signs Mailroom's Domain Connect links (one-click DNS at Cloudflare, GoDaddy…):
# the private key goes straight into the Worker secret DOMAIN_CONNECT_PRIVATE_KEY (never printed),
# and the public key is printed as the TXT records to add at _dck1.<syncPubKeyDomain>.
# Run it once, from the repo, with wrangler logged in. See domain-connect/README.md.
#
#   scripts/domain-connect-key.sh <provider id>     e.g. mailroom.example.com
set -euo pipefail
cd "$(dirname "$0")/.."
provider="${1:?usage: scripts/domain-connect-key.sh <provider id, e.g. mailroom.example.com>}"
host="_dck1.${provider#_dck1.}"
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$dir/key.pem" 2>/dev/null
openssl pkcs8 -topk8 -nocrypt -in "$dir/key.pem" -out "$dir/pkcs8.pem"
bunx wrangler secret put DOMAIN_CONNECT_PRIVATE_KEY < "$dir/pkcs8.pem"
public="$(openssl rsa -in "$dir/key.pem" -pubout 2>/dev/null | grep -v -- '-----' | tr -d '\n')"
echo
echo "Add these TXT records at ${host} (one record per line, DNS only):"
i=1
while [ -n "$public" ]; do
	echo "  p=${i},a=RS256,d=${public:0:200}"
	public="${public:200}"
	i=$((i + 1))
done
