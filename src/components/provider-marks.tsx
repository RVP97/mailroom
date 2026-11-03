import AE from "country-flag-icons/string/3x2/AE";
import AU from "country-flag-icons/string/3x2/AU";
import BH from "country-flag-icons/string/3x2/BH";
import BR from "country-flag-icons/string/3x2/BR";
import CA from "country-flag-icons/string/3x2/CA";
import CH from "country-flag-icons/string/3x2/CH";
import DE from "country-flag-icons/string/3x2/DE";
import ES from "country-flag-icons/string/3x2/ES";
import FR from "country-flag-icons/string/3x2/FR";
import GB from "country-flag-icons/string/3x2/GB";
import HK from "country-flag-icons/string/3x2/HK";
import ID from "country-flag-icons/string/3x2/ID";
import IE from "country-flag-icons/string/3x2/IE";
import IL from "country-flag-icons/string/3x2/IL";
import IN from "country-flag-icons/string/3x2/IN";
import IT from "country-flag-icons/string/3x2/IT";
import JP from "country-flag-icons/string/3x2/JP";
import KR from "country-flag-icons/string/3x2/KR";
import MX from "country-flag-icons/string/3x2/MX";
import MY from "country-flag-icons/string/3x2/MY";
import SE from "country-flag-icons/string/3x2/SE";
import SG from "country-flag-icons/string/3x2/SG";
import US from "country-flag-icons/string/3x2/US";
import ZA from "country-flag-icons/string/3x2/ZA";
import { Globe } from "lucide-react";
import {
	type SimpleIcon,
	siCloudflare,
	siDigitalocean,
	siGandi,
	siGodaddy,
	siGooglecloud,
	siHetzner,
	siHostinger,
	siIonos,
	siNamecheap,
	siNamesilo,
	siNetlify,
	siOvh,
	siPorkbun,
	siSquarespace,
	siVercel,
	siWix,
} from "simple-icons";
import type { DnsHostId } from "@/lib/dns-hosts";
import { cn } from "@/lib/utils";

/** The DNS hosts' and SES regions' marks for the domain page: a logo, a flag. */

const LOGOS: Partial<Record<DnsHostId, SimpleIcon>> = {
	cloudflare: siCloudflare,
	godaddy: siGodaddy,
	namecheap: siNamecheap,
	hostinger: siHostinger,
	wix: siWix,
	squarespace: siSquarespace,
	googleCloud: siGooglecloud,
	ionos: siIonos,
	digitalocean: siDigitalocean,
	vercel: siVercel,
	netlify: siNetlify,
	porkbun: siPorkbun,
	hetzner: siHetzner,
	ovh: siOvh,
	gandi: siGandi,
	namesilo: siNamesilo,
};

/** Hosts without a mark in Simple Icons: their initials on their colour. */
const MONOGRAMS: Partial<Record<DnsHostId, [string, string]>> = {
	route53: ["53", "#8C4FFF"],
	azure: ["Az", "#0078D4"],
	hostgator: ["HG", "#FF6C2C"],
	bluehost: ["B", "#3575D3"],
	neubox: ["N", "#E4002B"],
	akky: ["A", "#00A3E0"],
};

/** A DNS host's logo in a small round chip (Resend-style), or a globe when we don't know it. */
export function DnsHostMark({ id, className }: { id: DnsHostId | null; className?: string }) {
	const base = cn(
		"inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.08)]",
		className,
	);
	const logo = id ? LOGOS[id] : undefined;
	if (logo)
		return (
			<span
				className={base}
				aria-hidden="true"
			>
				<svg
					viewBox="0 0 24 24"
					aria-hidden="true"
					className="size-3"
					fill={`#${logo.hex}`}
				>
					<path d={logo.path} />
				</svg>
			</span>
		);
	const mono = id ? MONOGRAMS[id] : undefined;
	if (mono)
		return (
			<span
				className={cn(base, "text-[8px] font-bold tracking-tight text-white")}
				style={{ background: mono[1] }}
				aria-hidden="true"
			>
				{mono[0]}
			</span>
		);
	return (
		<span
			className={cn(base, "bg-muted text-muted-foreground")}
			aria-hidden="true"
		>
			<Globe className="size-3" />
		</span>
	);
}

const FLAGS: Record<string, string> = {
	AE,
	AU,
	BH,
	BR,
	CA,
	CH,
	DE,
	ES,
	FR,
	GB,
	HK,
	ID,
	IE,
	IL,
	IN,
	IT,
	JP,
	KR,
	MX,
	MY,
	SE,
	SG,
	US,
	ZA,
};

/** A country's flag, 3:2, with a hairline so white flags keep their edge. */
export function Flag({ country, className }: { country: string; className?: string }) {
	const svg = FLAGS[country];
	if (!svg) return null;
	return (
		<span
			className={cn(
				"inline-flex h-3 w-[18px] shrink-0 overflow-hidden rounded-[2px] shadow-[0_0_0_1px_rgb(0_0_0/0.12)] [&>svg]:size-full",
				className,
			)}
			aria-hidden="true"
			// Flags are static SVG from country-flag-icons.
			// biome-ignore lint/security/noDangerouslySetInnerHtml: trusted package content
			dangerouslySetInnerHTML={{ __html: svg }}
		/>
	);
}
