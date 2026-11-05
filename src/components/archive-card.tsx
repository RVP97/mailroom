import { Archive, Download } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { listArchiveFn, setArchiveFn } from "@/functions/archive";
import { errorMessage } from "@/lib/errors";

type Data = Awaited<ReturnType<typeof listArchiveFn>>;

const KIND = {
	emails: "Emails and events",
	bodies: "Content",
	received: "Received",
	chats: "Website chats",
} as const;

const size = (n: number) =>
	n < 1024
		? `${n} B`
		: n < 1024 ** 2
			? `${Math.ceil(n / 1024)} KB`
			: `${(n / 1024 ** 2).toFixed(1)} MB`;

/**
 * The organization's long-term archive (src/server/archive.ts): a switch (off by default) and the
 * newest files, each a download.
 */
export function ArchiveCard({ canManage }: { canManage: boolean }) {
	const [data, setData] = useState<Data | null>(null);
	const [failed, setFailed] = useState(false);
	const [busy, setBusy] = useState(false);
	const toggle = async (on: boolean) => {
		setBusy(true);
		try {
			await setArchiveFn({ data: { on } });
			setData((d) => (d ? { ...d, on } : d));
			toast.success(on ? "Archive on" : "Archive off");
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setBusy(false);
		}
	};
	useEffect(() => {
		listArchiveFn()
			.then(setData)
			.catch(() => setFailed(true));
	}, []);
	const multi = new Set(data?.files.map((f) => f.brand_id)).size > 1;
	return (
		<Card>
			<CardHeader>
				<CardTitle>Archive</CardTitle>
				<CardDescription>
					{data && !data.available
						? "Needs an R2 bucket: bind ARCHIVE (or INBOUND) to the Worker. Until then, emails past retention are deleted."
						: `When it's on, emails past retention (content after ${data?.retention.bodies ?? 7} days, emails and their events after ${data?.retention.emails ?? 90}, received emails after ${data?.retention.received ?? 30}) move to R2 as gzip NDJSON by brand and day instead of being deleted. When it's off, they're deleted.`}
				</CardDescription>
				{data?.available ? (
					<CardAction>
						<Switch
							checked={data.on}
							disabled={!canManage || busy}
							onCheckedChange={toggle}
							aria-label="Archive emails past retention"
						/>
					</CardAction>
				) : null}
			</CardHeader>
			{data?.available && (data.on || data.files.length) ? (
				<CardContent>
					{data.files.length ? (
						<ul className="divide-y rounded-md border text-sm">
							{data.files.map((f) => (
								<li
									key={f.key}
									className="flex items-center gap-3 px-3 py-2"
								>
									<Archive className="size-4 shrink-0 text-muted-foreground" />
									<div className="min-w-0 flex-1">
										<div className="truncate">
											{f.day} · {KIND[f.kind]}
											{multi ? ` · ${f.brand}` : ""}
										</div>
										<div className="text-muted-foreground text-xs">
											{f.count ? `${f.count.toLocaleString()} · ` : ""}
											{size(f.size)}
										</div>
									</div>
									<a
										href={f.url}
										className="inline-flex items-center gap-1 text-primary text-xs hover:underline"
										download
									>
										<Download className="size-3.5" />
										Download
									</a>
								</li>
							))}
						</ul>
					) : (
						<p className="text-muted-foreground text-sm">
							Nothing yet: files show up once emails pass retention.
						</p>
					)}
				</CardContent>
			) : failed ? (
				<CardContent>
					<p className="text-muted-foreground text-sm">The archive couldn't be listed.</p>
				</CardContent>
			) : null}
		</Card>
	);
}
