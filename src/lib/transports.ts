export const TRANSPORT_PROVIDERS = ["ses", "resend", "postmark"] as const;
export type TransportProvider = (typeof TRANSPORT_PROVIDERS)[number];

export const TRANSPORT_LABELS: Record<TransportProvider, string> = {
	ses: "Amazon SES (default · $0.10 / 1k)",
	resend: "Resend API (starter / fallback)",
	postmark: "Postmark API (starter / fallback)",
};
