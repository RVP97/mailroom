/** The demo's readers and customers: made-up names at the big mailbox providers and example.com. */
import { random } from "./time";

const FIRST = [
	"Ana",
	"Ben",
	"Chloe",
	"Daniel",
	"Elena",
	"Farah",
	"Gabriel",
	"Hana",
	"Isaac",
	"Julia",
	"Kenji",
	"Laura",
	"Mateo",
	"Nadia",
	"Omar",
	"Priya",
	"Quinn",
	"Rosa",
	"Samuel",
	"Tara",
	"Uma",
	"Victor",
	"Wen",
	"Ximena",
	"Yusuf",
	"Zoe",
	"Amir",
	"Bianca",
	"Carlos",
	"Dana",
	"Emil",
	"Freya",
	"Hugo",
	"Ines",
	"Jonas",
	"Keira",
	"Leo",
	"Maya",
	"Noah",
	"Olivia",
	"Pablo",
	"Rina",
	"Sofia",
	"Tomas",
	"Valeria",
	"Will",
	"Yara",
	"Lucas",
	"Mila",
	"Aiden",
];
const LAST = [
	"Garcia",
	"Smith",
	"Kim",
	"Okafor",
	"Rossi",
	"Nguyen",
	"Muller",
	"Silva",
	"Cohen",
	"Patel",
	"Haddad",
	"Novak",
	"Jensen",
	"Moreau",
	"Tanaka",
	"Ibrahim",
	"Kowalski",
	"Lopez",
	"Brown",
	"Singh",
	"Ferreira",
	"Larsen",
	"Costa",
	"Ahmed",
	"Reyes",
	"Fischer",
	"Murphy",
	"Sato",
	"Dubois",
	"Kaur",
];
/** Close to the share each provider has of a consumer list. */
const PROVIDERS: [string, number][] = [
	["gmail.com", 0.47],
	["outlook.com", 0.12],
	["yahoo.com", 0.08],
	["icloud.com", 0.12],
	["hotmail.com", 0.05],
	["proton.me", 0.03],
	["example.com", 0.13],
];

export interface Person {
	email: string;
	first: string;
	last: string;
	/** Days ago they joined. */
	joined: number;
	plan: "free" | "pro" | "team";
	city: string;
}

const CITIES = [
	"Lisbon",
	"Austin",
	"Toronto",
	"Berlin",
	"Mexico City",
	"Seoul",
	"Nairobi",
	"Sydney",
	"Madrid",
	"Chicago",
];

export function people(count: number, seed = 7): Person[] {
	const r = random(seed);
	const seen = new Set<string>();
	const out: Person[] = [];
	while (out.length < count) {
		const first = FIRST[Math.floor(r() * FIRST.length)] as string;
		const last = LAST[Math.floor(r() * LAST.length)] as string;
		let p = r();
		let domain = "gmail.com";
		for (const [d, share] of PROVIDERS) {
			p -= share;
			if (p < 0) {
				domain = d;
				break;
			}
		}
		const style = r();
		const local =
			style < 0.4
				? `${first}.${last}`
				: style < 0.7
					? `${first}${last[0]}${Math.floor(r() * 90 + 10)}`
					: `${first[0]}${last}`;
		const email = `${local}@${domain}`.toLowerCase();
		if (seen.has(email)) continue;
		seen.add(email);
		// More people joined lately: the list grows.
		const joined = Math.floor(180 * (1 - Math.sqrt(r())));
		const pr = r();
		out.push({
			email,
			first,
			last,
			joined,
			plan: pr < 0.62 ? "free" : pr < 0.9 ? "pro" : "team",
			city: CITIES[Math.floor(r() * CITIES.length)] as string,
		});
	}
	return out;
}
