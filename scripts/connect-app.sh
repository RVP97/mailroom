#!/usr/bin/env bash
# Connects an app that runs on Cloudflare Workers to a Mailroom organization: creates a
# sending-only API key and (with a URL) a webhook for every email event, and pipes both into the
# app's Worker secrets (MAILROOM_API_KEY, MAILROOM_WEBHOOK_SECRET). Nothing is printed: the values
# exist only in this shell's variables, Mailroom's database (the key as a SHA-256) and the Worker.
# Run it again to rotate: the previous key and webhook (same name, same URL) are removed once the
# new ones are in place.
#
#   scripts/connect-app.sh [--full] <organization-slug> <app-folder> [webhook-url]
#   scripts/connect-app.sh acme ~/code/acme https://acme.com/api/mailroom/webhook
#
# --full gives the key full access instead (domains, webhooks…), for an app that adds its customers'
# sending domains through the API.
#
# Needs: wrangler signed in to both accounts (Mailroom's D1 and the app's Worker), jq, openssl.
set -euo pipefail
trap 'echo "connect-app: stopped at line $LINENO (exit $?)" >&2' ERR

permission=sending
if [[ "${1:-}" == "--full" ]]; then
	permission=full
	shift
fi
org_slug="${1:?organization slug}"
app_dir="$(cd "${2:?app folder}" && pwd)"
hook_url="${3:-}"
here="$(cd "$(dirname "$0")/.." && pwd)"

[[ "$org_slug" =~ ^[a-z0-9-]+$ ]] || { echo "Invalid organization slug" >&2; exit 1; }
if [[ -n "$hook_url" && ! "$hook_url" =~ ^https://[^\'\ ]+$ ]]; then
	echo "The webhook URL must be https" >&2
	exit 1
fi

d1() { (cd "$here" && bunx wrangler d1 execute DB --remote --json --command "$1"); }
secret_put() { (cd "$app_dir" && bunx wrangler secret put "$1" >/dev/null); }
now() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }
uuid() { uuidgen | tr '[:upper:]' '[:lower:]'; }

org_id="$(d1 "SELECT id FROM organization WHERE slug = '$org_slug'" | jq -r '.[0].results[0].id // empty')"
[[ -n "$org_id" ]] || { echo "No organization '$org_slug' in Mailroom" >&2; exit 1; }

name="$(basename "$app_dir" | tr -cd 'A-Za-z0-9._-') (Worker)"

# The API key: «mr_» and 40 characters of Mailroom's alphabet, stored as its SHA-256.
old_keys="$(d1 "SELECT id FROM api_keys WHERE organization_id = '$org_id' AND name = '$name'" | jq -r '[.[0].results[].id] | map("'"'"'" + . + "'"'"'") | join(",")')"
# No pipe from /dev/urandom: `head` closing it kills `tr` (SIGPIPE), which pipefail turns into exit.
raw="$(openssl rand -base64 120)"
raw="${raw//[^abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789]/}"
token="mr_${raw:0:40}"
unset raw
[[ ${#token} -eq 43 ]] || { echo "Couldn't generate a key" >&2; exit 1; }
key_id="$(uuid)"
d1 "INSERT INTO api_keys (id, organization_id, name, start, hash, permission, created_at) VALUES ('$key_id', '$org_id', '$name', '${token:0:7}', '$(printf %s "$token" | shasum -a 256 | cut -d' ' -f1)', '$permission', '$(now)')" >/dev/null
if ! printf %s "$token" | secret_put MAILROOM_API_KEY; then
	d1 "DELETE FROM api_keys WHERE id = '$key_id'" >/dev/null
	echo "Couldn't write MAILROOM_API_KEY into the Worker; the new key was removed." >&2
	exit 1
fi
unset token
[[ -n "$old_keys" ]] && d1 "DELETE FROM api_keys WHERE id IN ($old_keys)" >/dev/null
echo "API key '$name' → MAILROOM_API_KEY"

if [[ -n "$hook_url" ]]; then
	old_hooks="$(d1 "SELECT id FROM webhooks WHERE organization_id = '$org_id' AND url = '$hook_url'" | jq -r '[.[0].results[].id] | map("'"'"'" + . + "'"'"'") | join(",")')"
	secret="whsec_$(openssl rand -base64 24)"
	hook_id="$(uuid)"
	events='["email.sent","email.delivered","email.delivery_delayed","email.bounced","email.complained","email.opened","email.clicked","email.failed","email.suppressed","email.scheduled"]'
	d1 "INSERT INTO webhooks (id, organization_id, url, secret, events, enabled, created_at) VALUES ('$hook_id', '$org_id', '$hook_url', '$secret', '$events', 1, '$(now)')" >/dev/null
	if ! printf %s "$secret" | secret_put MAILROOM_WEBHOOK_SECRET; then
		d1 "DELETE FROM webhooks WHERE id = '$hook_id'" >/dev/null
		echo "Couldn't write MAILROOM_WEBHOOK_SECRET into the Worker; the new webhook was removed." >&2
		exit 1
	fi
	unset secret
	[[ -n "$old_hooks" ]] && d1 "DELETE FROM webhooks WHERE id IN ($old_hooks)" >/dev/null
	echo "Webhook $hook_url → MAILROOM_WEBHOOK_SECRET"
fi
echo "Done. The Worker was redeployed with the new secrets."
