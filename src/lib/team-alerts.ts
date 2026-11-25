export const ALERT_KINDS = ["slack", "discord", "webhook"] as const;
export type AlertChannelKind = (typeof ALERT_KINDS)[number];

export const ALERT_EVENTS = [
	"chat.started",
	"inbox.inbound",
	"sla.warning",
	"sla.breached",
	"note.mention",
	"sending.alert",
] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number];

export const ALERT_EVENT_LABELS: Record<AlertEvent, string> = {
	"chat.started": "New live chat message",
	"inbox.inbound": "New inbound email",
	"sla.warning": "SLA reply due soon",
	"sla.breached": "SLA breached (overdue)",
	"note.mention": "Teammate @mentioned in note",
	"sending.alert": "Deliverability / SES alert",
};
