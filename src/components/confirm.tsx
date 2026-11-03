import { type ReactNode, useState } from "react";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/**
 * A destructive action behind a confirmation. The dialog stays open until it's done. Give it a
 * trigger, or control it with open/onOpenChange (when it opens from a menu item).
 */
export function Confirm({
	trigger,
	open: controlled,
	onOpenChange,
	title,
	description,
	action,
	cancel = "Cancel",
	onConfirm,
}: {
	trigger?: ReactNode;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	title: string;
	description: ReactNode;
	action: string;
	cancel?: string;
	onConfirm: () => void | Promise<void>;
}) {
	const [own, setOwn] = useState(false);
	const open = controlled ?? own;
	const setOpen = (v: boolean) => {
		setOwn(v);
		onOpenChange?.(v);
	};
	const [busy, setBusy] = useState(false);
	return (
		<AlertDialog
			open={open}
			onOpenChange={(v) => !busy && setOpen(v)}
		>
			{trigger && <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>}
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>{description}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={busy}>{cancel}</AlertDialogCancel>
					<Button
						variant="destructive"
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							try {
								await onConfirm();
								setOpen(false);
							} finally {
								setBusy(false);
							}
						}}
					>
						{busy && <Spinner />}
						{action}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
