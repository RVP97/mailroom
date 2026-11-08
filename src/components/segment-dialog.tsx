import { useRouter } from "@tanstack/react-router";
import { ListChecks, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { newCondition, type RuleOptions, SegmentRulesEditor } from "@/components/segment-rules";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { previewSegmentFn, saveSegmentFn, segmentOptionsFn } from "@/functions/contacts";
import { errorMessage } from "@/lib/errors";
import type { SegmentRules } from "@/server/live-segments";

export type EditedSegment = { id?: string; name: string; rules: SegmentRules | null };

type Preview = { count: number; sample: { id: string; email: string }[] };

/** New segment or edit one: a list people are added to, or live rules that keep it current. */
export function SegmentDialog({
	segment,
	onOpenChange,
	brand,
}: {
	segment: EditedSegment | null;
	onOpenChange: (v: boolean) => void;
	brand?: string;
}) {
	const router = useRouter();
	const [name, setName] = useState("");
	const [live, setLive] = useState(false);
	const [rules, setRules] = useState<SegmentRules | null>(null);
	const [options, setOptions] = useState<RuleOptions | null>(null);
	const [preview, setPreview] = useState<Preview | null>(null);
	const [checking, setChecking] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const open = !!segment;
	// An existing segment keeps what it is: lists and live segments hold people differently.
	const fixed = !!segment?.id;

	useEffect(() => {
		if (!segment) return;
		setName(segment.name);
		setLive(!!segment.rules);
		setRules(segment.rules);
		setPreview(null);
		setProblem(null);
		segmentOptionsFn({ data: { brand } })
			.then(setOptions)
			.catch(async (e) => toast.error(await errorMessage(e)));
	}, [segment, brand]);

	useEffect(() => {
		if (live && !rules && options)
			setRules({ match: "all", conditions: [newCondition("event", options)] });
	}, [live, rules, options]);

	// Counts who matches as the rules change, a moment after the last change.
	useEffect(() => {
		if (!open || !live || !rules) return;
		let stale = false;
		setChecking(true);
		const t = setTimeout(async () => {
			try {
				const p = await previewSegmentFn({ data: { brand, rules } });
				if (stale) return;
				setPreview(p);
				setProblem(null);
			} catch (e) {
				if (stale) return;
				setPreview(null);
				setProblem(await errorMessage(e));
			} finally {
				if (!stale) setChecking(false);
			}
		}, 400);
		return () => {
			stale = true;
			clearTimeout(t);
		};
	}, [open, live, rules, brand]);

	const save = async () => {
		setBusy(true);
		try {
			await saveSegmentFn({
				data: {
					brand,
					id: segment?.id,
					name: name.trim(),
					rules: live ? rules : fixed ? undefined : null,
				},
			});
			onOpenChange(false);
			toast.success(live ? "Live segment saved" : "Segment saved");
			await router.invalidate();
		} catch (e) {
			toast.error(await errorMessage(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogContent className={live ? "sm:max-w-3xl" : "sm:max-w-md"}>
				<form
					className="contents"
					onSubmit={(e) => {
						e.preventDefault();
						e.stopPropagation();
						save();
					}}
				>
					<DialogHeader>
						<DialogTitle>
							{fixed
								? live
									? "Edit live segment"
									: "Rename segment"
								: "New segment"}
						</DialogTitle>
						<DialogDescription>
							{live
								? "Mailroom keeps it up to date: people join when they match the rules and leave when they don't."
								: "A list you add people to by hand, by import, from a form or an automation."}
						</DialogDescription>
					</DialogHeader>
					<DialogBody className="flex flex-col gap-4">
						<Field>
							<FieldLabel htmlFor="segment-name">Name</FieldLabel>
							<Input
								id="segment-name"
								required
								autoFocus
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder={live ? "Active guests in Monterrey" : "Guests"}
							/>
						</Field>
						{!fixed && (
							<Field>
								<FieldLabel>Kind</FieldLabel>
								<ToggleGroup
									type="single"
									variant="outline"
									value={live ? "live" : "list"}
									onValueChange={(v) => v && setLive(v === "live")}
									className="w-full"
								>
									<ToggleGroupItem
										value="list"
										className="flex-1"
									>
										<ListChecks /> List
									</ToggleGroupItem>
									<ToggleGroupItem
										value="live"
										className="flex-1"
									>
										<Sparkles /> Live, from rules
									</ToggleGroupItem>
								</ToggleGroup>
							</Field>
						)}
						{live &&
							(rules && options ? (
								<>
									<SegmentRulesEditor
										value={rules}
										onChange={setRules}
										options={options}
									/>
									<div
										className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-muted/50 px-3 py-2 text-sm"
										aria-live="polite"
									>
										{problem ? (
											<span className="text-destructive">{problem}</span>
										) : preview ? (
											<>
												<span className="font-medium tabular-nums">
													{preview.count.toLocaleString()}{" "}
													{preview.count === 1
														? "contact matches"
														: "contacts match"}
												</span>
												{preview.sample.length > 0 && (
													<span className="min-w-0 truncate text-muted-foreground">
														{preview.sample
															.slice(0, 3)
															.map((c) => c.email)
															.join(", ")}
														{preview.count > 3 && ", …"}
													</span>
												)}
											</>
										) : (
											<span className="text-muted-foreground">Counting…</span>
										)}
										{checking && <Spinner className="ml-auto size-3.5" />}
									</div>
								</>
							) : (
								<div className="flex flex-col gap-2">
									<Skeleton className="h-14 w-full" />
									<Skeleton className="h-8 w-28" />
								</div>
							))}
					</DialogBody>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={busy || !name.trim() || (live && (!rules || !!problem))}
						>
							{busy && <Spinner />}
							Save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
