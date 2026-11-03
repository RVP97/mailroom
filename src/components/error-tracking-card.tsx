import { ArrowUpRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { sentryTestFn } from "@/functions/admin";

/** Admin › Error tracking: where errors go, and an error on purpose from each side. */
export function ErrorTrackingCard() {
	const enabled = Boolean(__SENTRY_DSN__) && import.meta.env.PROD;
	return (
		<Card>
			<CardHeader>
				<CardTitle>Error tracking</CardTitle>
				<CardDescription>
					{enabled
						? "Errors in the dashboard and the Worker go to Sentry, with the source's own files and lines. Send one on purpose to check."
						: "Off here: errors go to Sentry only in production builds with SENTRY_DSN set."}
				</CardDescription>
			</CardHeader>
			<CardFooter className="flex flex-wrap gap-2">
				<Button
					variant="outline"
					size="sm"
					disabled={!enabled}
					onClick={() => {
						// Thrown outside React, like a bug in an event handler: Sentry's global handler
						// takes it.
						setTimeout(() => {
							throw new Error(
								`Sentry test from the dashboard (${new Date().toISOString()})`,
							);
						});
						toast.success("Sent an error from the dashboard");
					}}
				>
					Test the dashboard
				</Button>
				<Button
					variant="outline"
					size="sm"
					disabled={!enabled}
					onClick={() =>
						sentryTestFn({ data: {} }).catch(() =>
							toast.success("Sent an error from the Worker"),
						)
					}
				>
					Test the Worker
				</Button>
				{__SENTRY_ISSUES_URL__ && (
					<Button
						variant="ghost"
						size="sm"
						asChild
					>
						<a
							href={__SENTRY_ISSUES_URL__}
							target="_blank"
							rel="noreferrer"
						>
							Open Sentry
							<ArrowUpRight />
						</a>
					</Button>
				)}
			</CardFooter>
		</Card>
	);
}
