/** An inbox's workflow settings as they are before anyone changes them (the server's defaults,
 * src/server/inbox-workflow.ts), for pages drawn before their data arrives. */
export const DEFAULT_INBOX_SETTINGS = {
	signature: null as string | null,
	assignment: {
		mode: "manual" as "manual" | "round_robin",
		members: [] as string[],
		max_open: null as number | null,
		last: null as string | null,
	},
	claim_minutes: 15,
	sla: {
		enabled: false,
		targets: {
			urgent: { reply: 60, resolve: 8 * 60 },
			high: { reply: 4 * 60, resolve: 24 * 60 },
			normal: { reply: 8 * 60, resolve: 3 * 24 * 60 },
			low: { reply: 24 * 60, resolve: 7 * 24 * 60 },
		} as Record<
			"urgent" | "high" | "normal" | "low",
			{ reply: number | null; resolve: number | null }
		>,
		business_hours: null as {
			timezone: string;
			days: number[];
			start: string;
			end: string;
		} | null,
		warn_minutes: 30,
		notify: [] as string[],
	},
	csat: {
		enabled: false,
		question: "How did we do?",
		thanks: "Thanks for telling us.",
		delay_minutes: 10,
		survey_id: null,
	},
	hold_suspicious: true,
	undo_seconds: 5,
	tags: [] as { name: string; color: string }[],
};
