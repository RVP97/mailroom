/** The least an IAM user needs for Mailroom (shown on the AWS page and in the README). */
export const IAM_POLICY = JSON.stringify(
	{
		Version: "2012-10-17",
		Statement: [
			{
				Sid: "MailroomSes",
				Effect: "Allow",
				Action: [
					"ses:SendEmail",
					"ses:SendRawEmail",
					"ses:GetAccount",
					"ses:CreateEmailIdentity",
					"ses:GetEmailIdentity",
					"ses:DeleteEmailIdentity",
					"ses:PutEmailIdentityMailFromAttributes",
					"ses:CreateConfigurationSet",
					"ses:CreateConfigurationSetEventDestination",
					"ses:UpdateConfigurationSetEventDestination",
					"ses:TagResource",
					"ses:CreateTenant",
					"ses:GetTenant",
					"ses:CreateTenantResourceAssociation",
					"ses:DeleteTenantResourceAssociation",
					"ses:GetReputationEntity",
					"ses:DeleteSuppressedDestination",
					// Receiving (src/server/inbound.ts): receipt rules for the domains that receive.
					"ses:DescribeActiveReceiptRuleSet",
					"ses:CreateReceiptRuleSet",
					"ses:SetActiveReceiptRuleSet",
					"ses:CreateReceiptRule",
					"ses:DeleteReceiptRule",
				],
				Resource: "*",
			},
			{
				// Receiving: the S3 drop box SES puts each message in until Mailroom moves it to R2.
				Sid: "MailroomInbound",
				Effect: "Allow",
				Action: [
					"s3:CreateBucket",
					"s3:PutBucketPolicy",
					"s3:PutLifecycleConfiguration",
					"s3:GetObject",
					"s3:DeleteObject",
				],
				Resource: ["arn:aws:s3:::mailroom-inbound-*", "arn:aws:s3:::mailroom-inbound-*/*"],
			},
			{
				// SMTP credentials (src/server/smtp.ts): users under /mailroom-smtp/, created and given
				// policies only with the send-only permissions boundary, so they can never do more.
				Sid: "MailroomSmtpUsers",
				Effect: "Allow",
				Action: ["iam:CreateUser", "iam:PutUserPolicy"],
				Resource: "arn:aws:iam::*:user/mailroom-smtp/*",
				Condition: {
					ArnLike: {
						"iam:PermissionsBoundary": "arn:aws:iam::*:policy/mailroom-smtp-boundary",
					},
				},
			},
			{
				Sid: "MailroomSmtpKeys",
				Effect: "Allow",
				Action: [
					"iam:CreateAccessKey",
					"iam:DeleteAccessKey",
					"iam:ListAccessKeys",
					"iam:DeleteUserPolicy",
					"iam:DeleteUser",
				],
				Resource: "arn:aws:iam::*:user/mailroom-smtp/*",
			},
			{
				Sid: "MailroomEvents",
				Effect: "Allow",
				Action: [
					"sns:CreateTopic",
					"sns:Subscribe",
					"sns:GetTopicAttributes",
					"sns:SetTopicAttributes",
				],
				Resource: "arn:aws:sns:*:*:mailroom-ses-events",
			},
			{
				// The AWS page's costs (src/server/costs.ts). Cost Explorer has no resources to
				// narrow it to, and reads only.
				Sid: "MailroomCosts",
				Effect: "Allow",
				Action: ["ce:GetCostAndUsage", "ce:GetCostForecast"],
				Resource: "*",
			},
		],
	},
	null,
	2,
);

/** The most an SMTP user can ever do (the permissions boundary of every one): send email. */
export const SMTP_BOUNDARY_POLICY = JSON.stringify({
	Version: "2012-10-17",
	Statement: [{ Effect: "Allow", Action: "ses:SendRawEmail", Resource: "*" }],
});
