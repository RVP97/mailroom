/** A small CSV reader: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text) {
	const rows = [];
	let row = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"' && text[i + 1] === '"') {
				field += '"';
				i++;
			} else if (c === '"') quoted = false;
			else field += c;
		} else if (c === '"') quoted = true;
		else if (c === "," || c === ";") {
			row.push(field);
			field = "";
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && text[i + 1] === "\n") i++;
			row.push(field);
			if (row.some((x) => x.trim())) rows.push(row);
			row = [];
			field = "";
		} else field += c;
	}
	row.push(field);
	if (row.some((x) => x.trim())) rows.push(row);
	return rows;
}
