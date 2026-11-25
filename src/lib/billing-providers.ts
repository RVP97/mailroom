export const BILLING_PROVIDERS = ["stripe", "polar", "lemonsqueezy"] as const;
export type BillingProvider = (typeof BILLING_PROVIDERS)[number];

export const BILLING_PROVIDER_LABELS: Record<BillingProvider, string> = {
	stripe: "Stripe",
	polar: "Polar",
	lemonsqueezy: "Lemon Squeezy",
};
