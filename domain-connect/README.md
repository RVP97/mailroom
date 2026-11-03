# Domain Connect template

`mailroom.example.com.sending-domain.json` lets a domain's DNS host add every record Mailroom
needs in one click ("Connect Cloudflare" on the domain page). The page only shows the button once
the domain's DNS host says it has this template (`src/server/domain-connect.ts`); until then it
names the host (from the nameservers), links to its DNS page and writes record names the way it
wants them typed.

- Groups, applied under the domain's subdomain (`host=mail`) and only for what's still missing:
  `dkim` (SES's three DKIM CNAMEs), `mailfrom` (bounce MX and SPF on `bounce.`), `dmarc`
  (monitoring only, skipped when any DMARC record already covers the domain), `tracking`
  (`links.` → `track.mailroom.example.com`, only once Mailroom has made `links.<domain>` a
  Cloudflare for SaaS custom hostname, else it would serve Cloudflare's error page) and `bimi`
  (`default._bimi`, pointing to the logo Mailroom serves, skipped when any BIMI record is there).
- Cloudflare ignores the template's TXT conflict matching: applying `dmarc` or `bimi` over an
  existing record adds a second one beside it. That's why both are left out whenever a record
  exists or couldn't be read. The SPF on `bounce.` is merged into any SPF already there.
- Links are signed (RS256) with the Worker secret `DOMAIN_CONNECT_PRIVATE_KEY`; its public key is
  the TXT records at `_dck1.mailroom.example.com` (`p=1,a=RS256,d=…`, `p=2,…`).
  `scripts/domain-connect-key.sh mailroom.example.com` makes the key, puts the secret and prints the records. To
  rotate: publish the new key at `_dck2`, set the secret, change `keyHost`.
- The template's source of truth is its copy in https://github.com/Domain-Connect/Templates.
  Bump `version` there for any change; Cloudflare picks it up within hours.

## Onboarding a DNS host

1. Open a pull request with the template in Domain-Connect/Templates and get it merged.
2. Cloudflare: email domain-connect@cloudflare.com with the template's GitHub link, the key lookup
   `_dck1.mailroom.example.com`, the logo (https://mailroom.example.com/favicon.svg), proxy
   status **off** for CNAME records, and optionally a Cloudflare account id to test with first.
3. Other hosts (GoDaddy, IONOS…) each have their own onboarding; see https://www.domainconnect.org.

The template here is an example for a deployment at mailroom.example.com. Yours needs its own
`providerId`, key domain, redirect domain and `links.` target (which must be your
`TRACKING_CNAME_TARGET`): copy this one with your values, onboard it as above, make the key with
`scripts/domain-connect-key.sh <provider id>` and set the var `DOMAIN_CONNECT_PROVIDER_ID` to the
provider id. Without it, the domain page still names the DNS host but has no Connect button.
