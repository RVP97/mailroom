#!/usr/bin/env bash
# Identity verification for an app's website chat: makes a new identity secret for an inbox's
# chat and pipes it into the app's Worker secret MAILROOM_CHAT_SECRET, so the app can sign who
# its signed-in visitors are (src/server/chat-identity.ts). Nothing is printed: the value exists
# only in this shell's variable, Mailroom's database and the Worker. Run it again to rotate (the
# old secret stops at once; until the Worker has the new one its tokens are refused).
#
#   scripts/connect-chat.sh <organization-slug> <inbox-address-or-id> <app-folder>
#   scripts/connect-chat.sh acme soporte@acme.com ~/code/acme
#
# Needs: wrangler signed in to both accounts (Mailroom's D1 and the app's Worker), jq, openssl.
# Mailroom's D1 is in MAILROOM_ACCOUNT_ID (default: the Rovapin account), so wrangler doesn't stop to ask
# which account when it's signed in to several; the app's Worker uses its own wrangler.jsonc account_id.
set -euo pipefail
trap 'echo "connect-chat: stopped at line $LINENO (exit $?)" >&2' ERR

org_slug="${1:?organization slug}"
inbox_ref="${2:?inbox address or id}"
app_dir="$(cd "${3:?app folder}" && pwd)"
here="$(cd "$(dirname "$0")/.." && pwd)"

[[ "$org_slug" =~ ^[a-z0-9-]+$ ]] || { echo "Invalid organization slug" >&2; exit 1; }
[[ "$inbox_ref" =~ ^[A-Za-z0-9@._+-]+$ ]] || { echo "Invalid inbox" >&2; exit 1; }

d1() { (cd "$here" && CLOUDFLARE_ACCOUNT_ID="${MAILROOM_ACCOUNT_ID:-0a386cbd8884cf2b1dbdb84125d4a364}" bunx wrangler d1 execute DB --remote --json --command "$1"); }
now() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }

org_id="$(d1 "SELECT id FROM organization WHERE slug = '$org_slug'" | jq -r '.[0].results[0].id // empty')"
[[ -n "$org_id" ]] || { echo "No organization '$org_slug' in Mailroom" >&2; exit 1; }
# On the organization's own brand or any of its other brands (managed_organizations).
inbox_id="$(d1 "SELECT w.inbox_id AS id FROM chat_widgets w JOIN inboxes i ON i.id = w.inbox_id WHERE (i.organization_id = '$org_id' OR i.organization_id IN (SELECT organization_id FROM managed_organizations WHERE parent_id = '$org_id')) AND (i.id = '$inbox_ref' OR lower(i.address) = lower('$inbox_ref'))" | jq -r '.[0].results[0].id // empty')"
[[ -n "$inbox_id" ]] || { echo "No website chat on inbox '$inbox_ref' in '$org_slug' (turn the chat on first)" >&2; exit 1; }

# «mrcs_» and 40 characters of Mailroom's alphabet (no pipe from /dev/urandom: SIGPIPE).
raw="$(openssl rand -base64 120)"
raw="${raw//[^abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789]/}"
secret="mrcs_${raw:0:40}"
unset raw
[[ ${#secret} -eq 45 ]] || { echo "Couldn't generate a secret" >&2; exit 1; }
if ! printf %s "$secret" | (cd "$app_dir" && bunx wrangler secret put MAILROOM_CHAT_SECRET >/dev/null); then
	echo "Couldn't write MAILROOM_CHAT_SECRET into the Worker; nothing changed in Mailroom." >&2
	exit 1
fi
d1 "UPDATE chat_widgets SET identity_secret = '$secret', updated_at = '$(now)' WHERE inbox_id = '$inbox_id'" >/dev/null
unset secret
echo "Identity secret for the chat on '$inbox_ref' → MAILROOM_CHAT_SECRET (Mailroom picks it up within a minute)."
