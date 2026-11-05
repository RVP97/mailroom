import {
	type Align,
	type Block,
	DEFAULT_THEME,
	type EmailDoc,
	esc,
	type LeafBlock,
	type LogoShape,
	mix,
	newId,
	onColor,
	type TextSize,
	type Theme,
} from "./email-doc";

/**
 * Ready-made designs to start an email from (broadcasts, newsletter issues, campaign emails and
 * transactional templates): each one built for the brand it's for, with its logo shown the way
 * the person picks (or not at all), sample pictures Mailroom hosts, and, when asked, the brand
 * kit's colors and fonts in place of the design's own.
 */

export type TemplateCategory =
	| "newsletter"
	| "announcement"
	| "promotion"
	| "event"
	| "welcome"
	| "feedback"
	| "transactional"
	| "plain";

export const CATEGORIES: { id: TemplateCategory; label: string }[] = [
	{ id: "newsletter", label: "Newsletters" },
	{ id: "announcement", label: "Announcements" },
	{ id: "promotion", label: "Promotions" },
	{ id: "event", label: "Events" },
	{ id: "welcome", label: "Welcome" },
	{ id: "feedback", label: "Feedback" },
	{ id: "transactional", label: "Transactional" },
	{ id: "plain", label: "Plain" },
];

/** How the logo shows in a design: not at all, or as it is, rounded or in a circle. */
export type LogoChoice = "off" | LogoShape;

export type TemplateBrand = {
	name: string;
	/** The brand's logo (a square image), if it has one. */
	logo: string | null;
	/** What the brand shows behind its logo ("#rrggbb"), if it picked a color. */
	logoBackground?: string | null;
};

export type TemplateOptions = {
	logo?: LogoChoice;
	/** Where Mailroom's sample pictures are (the dashboard's address). */
	origin?: string;
	/** The brand kit's look, used over each design's own colors and fonts. */
	kit?: Partial<Theme> | null;
};

/** The few colors a design is built on; with a kit, they come from it. */
type Palette = { accent: string; dark: string; tint: string };

type Ctx = {
	brand: string;
	p: Palette;
	img: (name: string) => string;
	/** The brand's logo as picked (or its name, without a logo); nothing when it's off. */
	logo: (o?: { align?: Align; width?: number; onDark?: boolean }) => LeafBlock[];
};

export type StarterDesign = {
	id: string;
	name: string;
	category: TemplateCategory;
	hint: string;
	theme: Partial<Theme>;
	palette: Palette;
	blocks: (c: Ctx) => Block[];
};

// ── Small builders ──────────────────────────────────────────────────────────

const id = newId;
const h = (html: string, level: 0 | 1 | 2 | 3 = 1, align: Align = "left"): LeafBlock => ({
	id: id(),
	type: "heading",
	html,
	level,
	align,
});
const t = (html: string, o: { align?: Align; size?: TextSize } = {}): LeafBlock => ({
	id: id(),
	type: "text",
	html,
	align: o.align ?? "left",
	...(o.size && o.size !== "body" ? { size: o.size } : {}),
});
const small = (html: string, align: Align = "left") =>
	t(`<p>${html}</p>`, { align, size: "small" });
const btn = (
	label: string,
	o: { url?: string; align?: Align; full?: boolean; color?: string | null } = {},
): LeafBlock => ({
	id: id(),
	type: "button",
	label,
	url: o.url ?? "",
	align: o.align ?? "left",
	full: o.full ?? false,
	color: o.color ?? null,
});
const img = (src: string, o: { width?: number; align?: Align; alt?: string } = {}): LeafBlock => ({
	id: id(),
	type: "image",
	src,
	alt: o.alt ?? "",
	href: "",
	width: o.width ?? 100,
	align: o.align ?? "center",
});
const hr = (): LeafBlock => ({ id: id(), type: "divider" });
const gap = (height: number): LeafBlock => ({ id: id(), type: "spacer", height });
const quote = (html: string): LeafBlock => ({ id: id(), type: "quote", html });
const cols = (ratio: "1-1" | "1-2" | "2-1", a: LeafBlock[], b: LeafBlock[]): Block => ({
	id: id(),
	type: "columns",
	ratio,
	columns: [a, b],
});
const poll = (question: string, options: string[], align: Align = "left"): LeafBlock => ({
	id: id(),
	type: "poll",
	question,
	options,
	align,
});
const social = (align: Align = "center"): LeafBlock => ({
	id: id(),
	type: "social",
	align,
	links: [
		{ label: "Instagram", url: "" },
		{ label: "LinkedIn", url: "" },
		{ label: "Website", url: "" },
	],
});
const footer = (brand: string, line?: string): LeafBlock => ({
	id: id(),
	type: "footer",
	html: `<p>${line ?? `You're getting this because you signed up for news from ${esc(brand)}.`}</p>`,
	unsubscribe: "Unsubscribe",
});
/** A person's photo in a circle (the logo block, which crops cleanly). */
const photo = (src: string, width: number): LeafBlock => ({
	id: id(),
	type: "logo",
	src,
	alt: "",
	width,
	align: "left",
	href: "",
	shape: "circle",
	background: null,
});
/** The blocks on one band of color. */
const band = (bg: string, ...blocks: Block[]): Block[] => blocks.map((b) => ({ ...b, bg }));

// ── The designs ─────────────────────────────────────────────────────────────

const INTER: Partial<Theme> = { font: "inter", heading_font: "inter" };

export const STARTERS: StarterDesign[] = [
	// Newsletters
	{
		id: "weekly",
		name: "The weekly",
		category: "newsletter",
		hint: "A lead story, quick hits and a quote",
		theme: { ...INTER, background: "#f4f4f5", radius: 16 },
		palette: { accent: "#18181b", dark: "#18181b", tint: "#f4f4f5" },
		blocks: (c) => [
			...c.logo({ align: "left" }),
			small("ISSUE 24 &nbsp;·&nbsp; THIS WEEK"),
			h("Five things worth your time this week", 1),
			t(
				"<p>Hi {{{FIRST_NAME|there}}}, here's what we've been reading, making and talking about. Grab a coffee; it's a good one.</p>",
				{ size: "lead" },
			),
			img(c.img("hero-ocean"), { alt: "" }),
			h("The big story", 2),
			t(
				"<p>Open with the one thing your readers shouldn't miss. Two or three short paragraphs read best on a phone; link to the rest.</p>",
			),
			btn("Read the story"),
			hr(),
			h("Quick hits", 3),
			t(
				'<ul><li><a href="#">A short headline that links out</a>, and one line on why it matters.</li><li><a href="#">Something new we shipped</a>, in a sentence.</li><li><a href="#">A recommendation</a> from the team.</li></ul>',
			),
			hr(),
			quote(
				"<p>“A line from a reader, a customer or someone on the team that's worth repeating.”</p>",
			),
			small("— Someone worth quoting"),
			footer(c.brand),
		],
	},
	{
		id: "editorial",
		name: "The long read",
		category: "newsletter",
		hint: "An essay in a book serif, made for reading",
		theme: {
			background: "#ffffff",
			surface: "#ffffff",
			text: "#292524",
			heading: "#1c1917",
			accent: "#9a3412",
			font: "book",
			heading_font: "book",
			size: 17,
			radius: 0,
			width: 600,
		},
		palette: { accent: "#9a3412", dark: "#1c1917", tint: "#faf7f2" },
		blocks: (c) => [
			...c.logo({ align: "center", width: 44 }),
			small("ESSAY &nbsp;·&nbsp; 6 MINUTE READ", "center"),
			h("On doing fewer things, better", 0, "center"),
			small("By the editors", "center"),
			hr(),
			t(
				"<p>Hi {{{FIRST_NAME|there}}},</p><p>Start with a scene, a question or a confession: something that makes a reader lean in. The first two lines decide whether the rest gets read.</p><p>Then make your case in short paragraphs. One idea each. Leave room around the important sentences so they can breathe.</p>",
			),
			quote("<p>The best sentence of the piece, pulled out so skimmers find it too.</p>"),
			t(
				"<p>Close by bringing it back to your reader: what they can do with this tomorrow morning.</p><p>Until next time,<br>The editors</p>",
			),
			footer(c.brand),
		],
	},
	{
		id: "roundup",
		name: "Link roundup",
		category: "newsletter",
		hint: "Numbered picks, each with a line and a link",
		theme: {
			...INTER,
			background: "#f5f5f4",
			heading: "#0c0a09",
			text: "#44403c",
			accent: "#0f766e",
			radius: 14,
		},
		palette: { accent: "#0f766e", dark: "#134e4a", tint: "#f0fdfa" },
		blocks: (c) => [
			...c.logo({ align: "left" }),
			h("This week's picks", 1),
			t("<p>Five links we loved, in the time it takes to finish a coffee.</p>", {
				size: "lead",
			}),
			...[
				["01", "A headline that makes people click"],
				["02", "The tool everyone's quietly using"],
				["03", "A long read for the weekend"],
				["04", "One chart that explains it all"],
				["05", "Something just for fun"],
			].flatMap(([n, title], i): Block[] => [
				...(i ? [hr()] : []),
				small(`<strong>${n}</strong>`),
				h(`<a href="#">${title}</a>`, 3),
				t("<p>One or two sentences on what it is and why it's worth their time.</p>"),
			]),
			...band(
				c.p.tint,
				h("Know something we should share?", 3, "center"),
				t("<p>Just reply to this email. We read every one.</p>", { align: "center" }),
			),
			footer(c.brand),
		],
	},
	{
		id: "magazine",
		name: "Magazine",
		category: "newsletter",
		hint: "A dark cover, then stories in a grid",
		theme: { ...INTER, background: "#e2e8f0", accent: "#e11d48", radius: 16 },
		palette: { accent: "#e11d48", dark: "#0f172a", tint: "#fff1f2" },
		blocks: (c) => [
			...band(
				c.p.dark,
				...c.logo({ align: "left", onDark: true }),
				small("THE NOVEMBER ISSUE"),
				h("The stories shaping this season", 0),
				t("<p>Four reads, picked by the team, for the weeks ahead.</p>", { size: "lead" }),
			),
			img(c.img("hero-night")),
			h("The cover story", 2),
			t(
				"<p>Your lead feature: a strong first line, a short summary and a reason to keep reading.</p>",
			),
			btn("Read the feature"),
			hr(),
			cols(
				"1-1",
				[
					img(c.img("hero-sunrise")),
					h("A second story", 3),
					t("<p>A short summary of it, in a line or two.</p>"),
				],
				[
					img(c.img("hero-forest")),
					h("A third story", 3),
					t("<p>A short summary of it, in a line or two.</p>"),
				],
			),
			cols(
				"1-1",
				[
					img(c.img("hero-sand")),
					h("A fourth story", 3),
					t("<p>A short summary of it, in a line or two.</p>"),
				],
				[
					img(c.img("hero-ocean")),
					h("A fifth story", 3),
					t("<p>A short summary of it, in a line or two.</p>"),
				],
			),
			social(),
			footer(c.brand),
		],
	},
	// Announcements
	{
		id: "launch",
		name: "Product launch",
		category: "announcement",
		hint: "A bold dark opening, a picture and what's in it",
		theme: { ...INTER, background: "#f4f4f5", accent: "#6366f1", radius: 18 },
		palette: { accent: "#6366f1", dark: "#111827", tint: "#eef2ff" },
		blocks: (c) => [
			...band(
				c.p.dark,
				...c.logo({ align: "center", onDark: true }),
				small("INTRODUCING", "center"),
				h("Meet the new way to get it done", 0, "center"),
				t(
					"<p>One sentence on what it is, and one on why it changes things for your customers.</p>",
					{ align: "center", size: "lead" },
				),
				btn("Try it now", { align: "center" }),
			),
			img(c.img("app-screen")),
			h("What's inside", 2),
			t(
				"<p><strong>Faster.</strong> Say what's quicker now, and by how much.</p><p><strong>Simpler.</strong> The step people no longer have to take.</p><p><strong>Yours.</strong> What they can make their own.</p>",
			),
			btn("See how it works"),
			hr(),
			small("Questions? Reply to this email and a real person will answer.", "center"),
			footer(c.brand),
		],
	},
	{
		id: "update",
		name: "Product update",
		category: "announcement",
		hint: "What's new this month, feature by feature",
		theme: { ...INTER, background: "#f8fafc", accent: "#2563eb", radius: 14 },
		palette: { accent: "#2563eb", dark: "#0f172a", tint: "#eff6ff" },
		blocks: (c) => [
			...c.logo({ align: "left" }),
			small("PRODUCT UPDATE &nbsp;·&nbsp; NOVEMBER"),
			h("What's new this month", 1),
			t("<p>Three improvements, all live today. Here's what changed and how to use it.</p>", {
				size: "lead",
			}),
			img(c.img("app-screen")),
			h("1 &nbsp;Faster search", 3),
			t("<p>What it does, in one or two sentences, and where to find it.</p>"),
			hr(),
			h("2 &nbsp;Shared views", 3),
			t("<p>What it does, in one or two sentences, and where to find it.</p>"),
			hr(),
			h("3 &nbsp;A cleaner home screen", 3),
			t("<p>What it does, in one or two sentences, and where to find it.</p>"),
			btn("See everything new"),
			footer(c.brand),
		],
	},
	{
		id: "big-news",
		name: "Big news",
		category: "announcement",
		hint: "One message, centered, with one button",
		theme: {
			...INTER,
			background: "#eef2ff",
			accent: "#4f46e5",
			heading: "#1e1b4b",
			radius: 20,
		},
		palette: { accent: "#4f46e5", dark: "#1e1b4b", tint: "#eef2ff" },
		blocks: (c) => [
			...c.logo({ align: "center", width: 56 }),
			gap(8),
			h("We have some big news", 0, "center"),
			t(
				"<p>Say it plainly in a sentence or two. What's changing, when, and what it means for the person reading.</p>",
				{ align: "center", size: "lead" },
			),
			btn("Read the announcement", { align: "center" }),
			gap(8),
			small("Thank you for being part of this.", "center"),
			footer(c.brand),
		],
	},
	// Promotions
	{
		id: "sale",
		name: "Sale",
		category: "promotion",
		hint: "A big offer on color, then favorites",
		theme: {
			...INTER,
			background: "#fff7ed",
			accent: "#ea580c",
			heading: "#1c1917",
			radius: 16,
		},
		palette: { accent: "#ea580c", dark: "#7c2d12", tint: "#ffedd5" },
		blocks: (c) => [
			...band(
				c.p.accent,
				...c.logo({ align: "center", onDark: true }),
				small("THIS WEEKEND ONLY", "center"),
				h("30% off everything", 0, "center"),
				t(
					"<p>Use the code <strong>WEEKEND30</strong> at checkout. Ends Sunday at midnight.</p>",
					{
						align: "center",
						size: "lead",
					},
				),
				btn("Shop the sale", { align: "center" }),
			),
			h("Our favorites", 2, "center"),
			cols(
				"1-1",
				[
					img(c.img("product-bottle")),
					h("The everyday bottle", 3, "center"),
					small("<s>$40</s> &nbsp;$28", "center"),
				],
				[
					img(c.img("product-mug")),
					h("The morning mug", 3, "center"),
					small("<s>$24</s> &nbsp;$17", "center"),
				],
			),
			cols(
				"1-1",
				[
					img(c.img("product-bag")),
					h("The weekend tote", 3, "center"),
					small("<s>$80</s> &nbsp;$56", "center"),
				],
				[
					img(c.img("product-lamp")),
					h("The reading lamp", 3, "center"),
					small("<s>$120</s> &nbsp;$84", "center"),
				],
			),
			btn("See everything on sale", { align: "center", full: true }),
			footer(c.brand, "Offer valid while stock lasts. Can't be combined with other codes."),
		],
	},
	{
		id: "new-arrivals",
		name: "New arrivals",
		category: "promotion",
		hint: "A calm, editorial look at what's new",
		theme: {
			background: "#f5f0e8",
			surface: "#fffdf9",
			text: "#44403c",
			heading: "#1c1917",
			accent: "#1c1917",
			font: "helvetica",
			heading_font: "georgia",
			radius: 4,
		},
		palette: { accent: "#1c1917", dark: "#292524", tint: "#f5f0e8" },
		blocks: (c) => [
			...c.logo({ align: "center", width: 48 }),
			img(c.img("hero-sand")),
			small("NEW IN", "center"),
			h("The autumn edit", 0, "center"),
			t("<p>Made slowly, in small batches. Here's what just arrived.</p>", {
				align: "center",
				size: "lead",
			}),
			btn("Shop new arrivals", { align: "center" }),
			cols(
				"1-1",
				[img(c.img("product-bag")), h("The weekend tote", 3), small("Waxed canvas · $80")],
				[
					img(c.img("product-lamp")),
					h("The reading lamp", 3),
					small("Brass and linen · $120"),
				],
			),
			footer(c.brand),
		],
	},
	{
		id: "back-in-stock",
		name: "Back in stock",
		category: "promotion",
		hint: "One product, one button",
		theme: { ...INTER, background: "#f1f5f9", accent: "#0f172a", radius: 16 },
		palette: { accent: "#0f172a", dark: "#0f172a", tint: "#f1f5f9" },
		blocks: (c) => [
			...c.logo({ align: "center" }),
			img(c.img("product-mug"), { width: 80 }),
			h("It's back", 1, "center"),
			t(
				"<p>The morning mug sold out in two days. We made more, but not many: get yours before it goes again.</p>",
				{ align: "center" },
			),
			btn("Get it now", { align: "center", full: true }),
			small("You asked us to let you know. This is us letting you know.", "center"),
			footer(c.brand),
		],
	},
	// Events
	{
		id: "invite",
		name: "Event invitation",
		category: "event",
		hint: "A picture, the details and a big RSVP",
		theme: { ...INTER, background: "#f5f5f4", accent: "#db2777", radius: 16 },
		palette: { accent: "#db2777", dark: "#0f172a", tint: "#fdf2f8" },
		blocks: (c) => [
			...c.logo({ align: "left" }),
			img(c.img("event-stage")),
			small("YOU'RE INVITED"),
			h("An evening with friends of the house", 1),
			t(
				"<p>Music, food and good company. We'd love to see you there, {{{FIRST_NAME|friend}}}.</p>",
				{ size: "lead" },
			),
			...band(
				c.p.tint,
				t(
					"<p><strong>When</strong><br>Friday, December 12 · 7 to 10 pm</p><p><strong>Where</strong><br>The address, with a link to the map</p>",
				),
			),
			btn("Save my spot", { full: true }),
			h("What to expect", 3),
			t(
				"<ul><li>A short welcome at 7:30</li><li>Food and drinks all evening</li><li>A surprise or two</li></ul>",
			),
			footer(c.brand),
		],
	},
	{
		id: "webinar",
		name: "Webinar",
		category: "event",
		hint: "A live session, its hosts and the agenda",
		theme: {
			...INTER,
			background: "#ecfeff",
			accent: "#0e7490",
			heading: "#083344",
			radius: 14,
		},
		palette: { accent: "#0e7490", dark: "#083344", tint: "#ecfeff" },
		blocks: (c) => [
			...c.logo({ align: "left" }),
			small("LIVE SESSION &nbsp;·&nbsp; 45 MINUTES &nbsp;·&nbsp; FREE"),
			h("How to plan a year in one afternoon", 1),
			t(
				"<p>Join us live on Thursday, November 20 at 5 pm. Bring your questions; we'll stay until they're answered.</p>",
				{ size: "lead" },
			),
			btn("Save my seat"),
			hr(),
			h("Your hosts", 3),
			cols(
				"1-1",
				[
					photo(c.img("person-1"), 64),
					h("First host", 3),
					small("What they do, and why they're worth listening to."),
				],
				[
					photo(c.img("person-2"), 64),
					h("Second host", 3),
					small("What they do, and why they're worth listening to."),
				],
			),
			...band(
				c.p.tint,
				h("The agenda", 3),
				t(
					"<p><strong>5:00</strong> &nbsp;Welcome<br><strong>5:05</strong> &nbsp;The method, step by step<br><strong>5:30</strong> &nbsp;Your questions</p>",
				),
			),
			small("Can't make it live? Sign up anyway and we'll send you the recording."),
			footer(c.brand),
		],
	},
	{
		id: "reminder",
		name: "Event reminder",
		category: "event",
		hint: "Short and to the point, the day before",
		theme: { ...INTER, background: "#fafaf9", accent: "#16a34a", radius: 14 },
		palette: { accent: "#16a34a", dark: "#14532d", tint: "#f0fdf4" },
		blocks: (c) => [
			...c.logo({ align: "left" }),
			h("See you tomorrow", 1),
			t(
				"<p>Hi {{{FIRST_NAME|there}}}, a quick reminder that it's tomorrow. Here's everything you need:</p>",
			),
			...band(
				c.p.tint,
				t(
					"<p><strong>Thursday, 5 pm</strong><br>Online: the link below opens the room 10 minutes early.</p>",
				),
			),
			btn("Add to my calendar"),
			small("Can't come after all? No problem: we'll send the recording."),
			footer(c.brand),
		],
	},
	// Welcome and onboarding
	{
		id: "welcome",
		name: "Welcome",
		category: "welcome",
		hint: "A warm hello and three first steps",
		theme: {
			...INTER,
			background: "#fdf4ff",
			accent: "#9333ea",
			heading: "#3b0764",
			radius: 20,
		},
		palette: { accent: "#9333ea", dark: "#3b0764", tint: "#faf5ff" },
		blocks: (c) => [
			...c.logo({ align: "center", width: 64 }),
			h("Welcome, {{{FIRST_NAME|friend}}}", 0, "center"),
			t(
				"<p>We're so glad you're here. Here's how to get the most out of the next five minutes.</p>",
				{ align: "center", size: "lead" },
			),
			...band(
				c.p.tint,
				h("1 &nbsp;Tell us about you", 3),
				small("A few details, so everything you see fits what you need."),
				h("2 &nbsp;Try the one thing people love most", 3),
				small("It takes a minute, and it's the best part."),
				h("3 &nbsp;Invite someone", 3),
				small("Everything's better with a friend."),
			),
			btn("Get started", { align: "center" }),
			small("Questions? Just reply: this comes from a real inbox.", "center"),
			footer(c.brand, `You're getting this because you just joined ${esc(c.brand)}.`),
		],
	},
	{
		id: "tips",
		name: "Getting started tips",
		category: "welcome",
		hint: "A few days in: three tips, one each",
		theme: { ...INTER, background: "#f0f9ff", accent: "#0284c7", radius: 14 },
		palette: { accent: "#0284c7", dark: "#0c4a6e", tint: "#f0f9ff" },
		blocks: (c) => [
			...c.logo({ align: "left" }),
			h("Three tips from people who love it", 1),
			t(
				"<p>Hi {{{FIRST_NAME|there}}}, you've been with us a few days. These make the biggest difference:</p>",
			),
			cols(
				"1-2",
				[img(c.img("hero-ocean"))],
				[
					h("Start with the basics", 3),
					small("One sentence on the tip, and why it helps."),
				],
			),
			cols(
				"1-2",
				[img(c.img("hero-forest"))],
				[h("Make it yours", 3), small("One sentence on the tip, and why it helps.")],
			),
			cols(
				"1-2",
				[img(c.img("hero-sunrise"))],
				[h("Bring your team", 3), small("One sentence on the tip, and why it helps.")],
			),
			btn("Open my account"),
			footer(c.brand),
		],
	},
	{
		id: "miss-you",
		name: "We miss you",
		category: "welcome",
		hint: "Win back quiet readers, with a one-click poll",
		theme: { ...INTER, background: "#fff1f2", accent: "#e11d48", radius: 18 },
		palette: { accent: "#e11d48", dark: "#4c0519", tint: "#fff1f2" },
		blocks: (c) => [
			...c.logo({ align: "center" }),
			img(c.img("hero-sunrise")),
			h("It's been a while, {{{FIRST_NAME|friend}}}", 1, "center"),
			t(
				"<p>We've made a few changes since you last stopped by, and we think you'll like them.</p>",
				{ align: "center" },
			),
			btn("See what's new", { align: "center" }),
			hr(),
			poll("What would you like more of?", [
				"Tips and how-tos",
				"News and updates",
				"Offers",
				"Less email, please",
			]),
			footer(c.brand),
		],
	},
	// Feedback
	{
		id: "survey",
		name: "Quick question",
		category: "feedback",
		hint: "One question, answered in one click",
		theme: { ...INTER, background: "#f4f4f5", accent: "#18181b", radius: 14 },
		palette: { accent: "#18181b", dark: "#18181b", tint: "#f4f4f5" },
		blocks: (c) => [
			...c.logo({ align: "left" }),
			h("Got ten seconds?", 1),
			t(
				"<p>Hi {{{FIRST_NAME|there}}}, we're deciding what to work on next, and your answer counts. Tap one; that's it.</p>",
			),
			poll("How are we doing?", ["Love it", "It's good", "It's okay", "Not great"]),
			small("Want to say more? Reply to this email. We read everything."),
			footer(c.brand),
		],
	},
	{
		id: "review",
		name: "Review request",
		category: "feedback",
		hint: "Ask happy customers for a review",
		theme: {
			...INTER,
			background: "#fefce8",
			accent: "#ca8a04",
			heading: "#1c1917",
			radius: 18,
		},
		palette: { accent: "#ca8a04", dark: "#422006", tint: "#fefce8" },
		blocks: (c) => [
			...c.logo({ align: "center" }),
			img(c.img("product-bag"), { width: 60 }),
			h("How did we do?", 1, "center"),
			t(
				"<p>You've had your order for a little while now. A short review helps other people decide, and helps us get better.</p>",
				{ align: "center" },
			),
			btn("Write a review", { align: "center" }),
			small("It takes about a minute. Thank you!", "center"),
			footer(c.brand),
		],
	},
	// Transactional
	{
		id: "confirm-email",
		name: "Confirm email",
		category: "transactional",
		hint: "A button to confirm an address",
		theme: { ...INTER, background: "#f4f4f5", accent: "#18181b", radius: 14 },
		palette: { accent: "#18181b", dark: "#18181b", tint: "#f4f4f5" },
		blocks: (c) => [
			...c.logo({ align: "left" }),
			h("Confirm your email", 1),
			t("<p>Tap the button to confirm it's you. The link works for the next 24 hours.</p>"),
			btn("Confirm my email", { url: "{{{CONFIRM_URL}}}" }),
			small("If you didn't ask for this, you can ignore this email; nothing will change."),
		],
	},
	{
		id: "code",
		name: "Sign-in code",
		category: "transactional",
		hint: "A one-time code, big and easy to copy",
		theme: { ...INTER, background: "#f4f4f5", accent: "#18181b", radius: 14 },
		palette: { accent: "#18181b", dark: "#18181b", tint: "#f4f4f5" },
		blocks: (c) => [
			...c.logo({ align: "left" }),
			h("Your sign-in code", 1),
			t("<p>Enter this code to finish signing in. It expires in 10 minutes.</p>"),
			...band(c.p.tint, h("{{{CODE}}}", 0, "center")),
			small(
				"Didn't try to sign in? Someone may have typed your email by mistake. You can ignore this.",
			),
		],
	},
	{
		id: "reset-password",
		name: "Reset password",
		category: "transactional",
		hint: "A safe, clear reset link",
		theme: { ...INTER, background: "#f8fafc", accent: "#2563eb", radius: 14 },
		palette: { accent: "#2563eb", dark: "#0f172a", tint: "#eff6ff" },
		blocks: (c) => [
			...c.logo({ align: "left" }),
			h("Reset your password", 1),
			t(
				"<p>Someone asked to reset the password for this account. If it was you, choose a new one:</p>",
			),
			btn("Choose a new password", { url: "{{{RESET_URL}}}" }),
			small(
				"The link works once, for the next hour. If you didn't ask, ignore this email: your password stays as it is.",
			),
		],
	},
	{
		id: "receipt",
		name: "Receipt",
		category: "transactional",
		hint: "An order, line by line, with the total",
		theme: { ...INTER, background: "#f4f4f5", accent: "#18181b", radius: 14 },
		palette: { accent: "#18181b", dark: "#18181b", tint: "#fafafa" },
		blocks: (c) => [
			...c.logo({ align: "left" }),
			h("Thanks for your order", 1),
			small("Order #{{{ORDER_NUMBER}}} &nbsp;·&nbsp; {{{ORDER_DATE}}}"),
			hr(),
			cols(
				"2-1",
				[t("<p>{{{ITEM_NAME}}} × {{{ITEM_QUANTITY|1}}}</p>")],
				[t("<p>{{{ITEM_PRICE}}}</p>", { align: "right" })],
			),
			cols("2-1", [small("Shipping")], [small("{{{SHIPPING}}}", "right")]),
			hr(),
			cols(
				"2-1",
				[t("<p><strong>Total</strong></p>")],
				[t("<p><strong>{{{TOTAL}}}</strong></p>", { align: "right" })],
			),
			btn("View my order", { url: "{{{ORDER_URL}}}" }),
			small("Questions about your order? Reply to this email."),
		],
	},
	{
		id: "shipped",
		name: "Order shipped",
		category: "transactional",
		hint: "It's on its way, with tracking",
		theme: { ...INTER, background: "#f0fdf4", accent: "#15803d", radius: 16 },
		palette: { accent: "#15803d", dark: "#14532d", tint: "#f0fdf4" },
		blocks: (c) => [
			...c.logo({ align: "left" }),
			img(c.img("product-mug"), { width: 50, align: "left" }),
			h("Your order is on its way", 1),
			t(
				"<p>Good news, {{{FIRST_NAME|there}}}: order {{{ORDER_NUMBER}}} left our hands today.</p>",
			),
			...band(
				c.p.tint,
				t(
					"<p><strong>Arrives</strong><br>{{{DELIVERY_DATE}}}</p><p><strong>Carrier</strong><br>{{{CARRIER}}}</p>",
				),
			),
			btn("Track my package", { url: "{{{TRACKING_URL}}}" }),
			small("We'll email you again when it's delivered."),
		],
	},
	// Plain
	{
		id: "letter",
		name: "Plain letter",
		category: "plain",
		hint: "Reads like a personal email",
		theme: {
			background: "#ffffff",
			radius: 0,
			font: "georgia",
			heading_font: "georgia",
			text: "#27272a",
			size: 17,
		},
		palette: { accent: "#18181b", dark: "#18181b", tint: "#fafafa" },
		blocks: (c) => [
			...c.logo({ align: "left", width: 40 }),
			t(
				"<p>Hi {{{FIRST_NAME|there}}},</p><p>Write to your readers the way you'd write to a friend. Short paragraphs read best on a phone.</p><p>Thanks for reading,<br>The team</p>",
			),
			{ ...footer(c.brand), html: "" },
		],
	},
	{
		id: "founder",
		name: "A note from the founder",
		category: "plain",
		hint: "Personal, signed with a photo",
		theme: {
			...INTER,
			background: "#fafaf9",
			text: "#3f3f46",
			radius: 12,
			size: 16,
		},
		palette: { accent: "#18181b", dark: "#18181b", tint: "#fafaf9" },
		blocks: (c) => [
			...c.logo({ align: "left", width: 40 }),
			t(
				"<p>Hi {{{FIRST_NAME|there}}},</p><p>I wanted to write to you myself. Say what's on your mind: what you've been working on, what you've learned, what's next.</p><p>Keep it honest and keep it short. People can tell when a person wrote it.</p><p>If you have a minute, hit reply and tell me what you think. I read every answer.</p>",
			),
			cols(
				"1-2",
				[photo(c.img("person-3"), 56)],
				[t("<p><strong>Your name</strong><br>Founder</p>", { size: "small" })],
			),
			footer(c.brand),
		],
	},
	{
		id: "blank",
		name: "Blank",
		category: "plain",
		hint: "Start from nothing",
		theme: {},
		palette: { accent: "#18181b", dark: "#18181b", tint: "#f4f4f5" },
		blocks: (c) => [...c.logo({ align: "left" }), t(""), footer(c.brand)],
	},
];

/** The palette a kit makes: its accent, its heading color (when dark) and a tint of the accent. */
function kitPalette(kit: Partial<Theme>, own: Palette): Palette {
	const accent = kit.accent ?? own.accent;
	const heading = kit.heading ?? own.dark;
	return {
		accent,
		dark: onColor(heading) === "#ffffff" ? heading : own.dark,
		tint: mix(accent, "#ffffff", 0.92),
	};
}

/** One of the designs, made for a brand. */
export function buildStarter(
	design: StarterDesign,
	brand: TemplateBrand,
	o: TemplateOptions = {},
): EmailDoc {
	const choice = o.logo ?? "original";
	const origin = (o.origin ?? "").replace(/\/$/, "");
	const p = o.kit ? kitPalette(o.kit, design.palette) : design.palette;
	const ctx: Ctx = {
		brand: brand.name || "us",
		p,
		img: (name) => `${origin}/templates/${name}.jpg`,
		logo: ({ align = "center", width } = {}) => {
			if (choice === "off") return [];
			if (!brand.logo)
				// No logo: the brand's name, set as a wordmark, so it never looks like something's missing.
				return brand.name ? [h(`${esc(brand.name)}`, 3, align)] : [];
			// Only the color the brand picked for behind its logo: no white rings added around it
			// (the logo panel offers one when a dark logo needs it on a dark band).
			const background = brand.logoBackground ?? null;
			return [
				{
					id: id(),
					type: "logo",
					src: brand.logo,
					alt: brand.name,
					width: width ?? (choice === "circle" ? 56 : 48),
					align,
					href: "",
					shape: choice,
					background,
				},
			];
		},
	};
	const theme: Theme = { ...DEFAULT_THEME, ...design.theme, ...(o.kit ?? {}) };
	return { version: 1, theme, blocks: design.blocks(ctx) };
}

/** A design by id, for a brand (the MCP's `starter`). */
export function starterDoc(designId: string, brand: TemplateBrand, o: TemplateOptions = {}) {
	const d = STARTERS.find((s) => s.id === designId);
	return d ? buildStarter(d, brand, o) : null;
}
