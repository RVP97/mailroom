/** Saves rows as a CSV file in the browser: the first row is the header. */
export function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]) {
	const cell = (v: string | number | null | undefined) => {
		const s = v == null ? "" : String(v);
		return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	};
	const csv = rows.map((r) => r.map(cell).join(",")).join("\r\n");
	const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Rows of a CSV file (quotes, "" inside quotes, CRLF or LF, a comma or semicolon). */
export function parseCsv(text: string): string[][] {
	const src = text.replace(/^﻿/, "");
	const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
	const sep =
		(firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i] as string;
		if (quoted) {
			if (ch === '"' && src[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (ch === '"') quoted = false;
			else cell += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === sep) {
			row.push(cell);
			cell = "";
		} else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && src[i + 1] === "\n") i++;
			row.push(cell);
			if (row.some((c) => c.trim())) rows.push(row);
			row = [];
			cell = "";
		} else cell += ch;
	}
	row.push(cell);
	if (row.some((c) => c.trim())) rows.push(row);
	return rows;
}
