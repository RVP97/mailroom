#!/usr/bin/env bash
# Re-puts the `mailroom` IAM user's inline policy from src/lib/iam-policy.ts (after it changes),
# and creates the send-only permissions boundary SMTP users get (src/server/smtp.ts), once.
set -euo pipefail
cd "$(dirname "$0")/.."
node -e 'const fs=require("fs");const s=fs.readFileSync("src/lib/iam-policy.ts","utf8");const p=eval("("+s.slice(s.indexOf("{"),s.lastIndexOf("},")+1)+")");console.log(JSON.stringify(p))' > /tmp/mailroom-policy.json
aws iam put-user-policy --user-name mailroom --policy-name mailroom --policy-document file:///tmp/mailroom-policy.json
rm /tmp/mailroom-policy.json
aws iam get-user-policy --user-name mailroom --policy-name mailroom --query 'PolicyDocument.Statement[0].Action' --output text | tr '\t' '\n' | grep -c . | xargs echo "SES actions in the policy:"

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
if aws iam get-policy --policy-arn "arn:aws:iam::$ACCOUNT:policy/mailroom-smtp-boundary" >/dev/null 2>&1; then
	echo "SMTP boundary: already there"
else
	aws iam create-policy --policy-name mailroom-smtp-boundary \
		--description "The most a Mailroom SMTP user can do: send email" \
		--policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"ses:SendRawEmail","Resource":"*"}]}' >/dev/null
	echo "SMTP boundary: created"
fi
