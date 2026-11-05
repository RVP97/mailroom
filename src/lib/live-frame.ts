import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A preview iframe that updates in place. Setting srcDoc again reloads the page: it flashes,
 * loses its scroll, fetches its fonts again and replays its entrance animations, so a design
 * that changes on every keystroke jumps. This loads the first document once and then patches the
 * live one to match each new document, node by node, so only what changed changes (and its CSS
 * transitions run). The frame needs `allow-same-origin` to be patched; it never runs scripts.
 *
 * `around` wraps each patch (call `apply` inside it), to measure before and animate after.
 */
export function useLiveFrame(doc: string, around?: (d: Document, apply: () => void) => void) {
	const ref = useRef<HTMLIFrameElement>(null);
	const [first] = useState(doc);
	const shown = useRef(first);
	const loaded = useRef(false);
	const latest = useRef(doc);
	latest.current = doc;
	const wrap = useRef(around);
	wrap.current = around;

	const update = useCallback(() => {
		const d = ref.current?.contentDocument;
		const next = latest.current;
		if (!d || !loaded.current || next === shown.current) return;
		shown.current = next;
		const apply = () => patchDocument(d, next);
		if (wrap.current) wrap.current(d, apply);
		else apply();
	}, []);

	// After every render: a no-op unless the document changed.
	useEffect(() => {
		update();
	});

	const onLoad = useCallback(() => {
		loaded.current = true;
		update();
	}, [update]);

	return { ref, srcDoc: first, onLoad, sandbox: "allow-same-origin" };
}

/** Makes the document match `html`, keeping every node that's still there. */
export function patchDocument(d: Document, html: string) {
	const next = new DOMParser().parseFromString(html, "text/html");
	morph(d.head, next.head);
	morph(d.body, next.body);
}

function morph(a: Element, b: Element) {
	for (const { name } of [...a.attributes]) if (!b.hasAttribute(name)) a.removeAttribute(name);
	for (const { name, value } of [...b.attributes])
		if (a.getAttribute(name) !== value) a.setAttribute(name, value);
	const doc = a.ownerDocument;
	const was = [...a.childNodes];
	const now = [...b.childNodes];
	now.forEach((y, i) => {
		const x = was[i];
		if (!x) {
			a.appendChild(doc.importNode(y, true));
			return;
		}
		if (x.nodeType !== y.nodeType || x.nodeName !== y.nodeName) {
			a.replaceChild(doc.importNode(y, true), x);
			return;
		}
		if (x.nodeType === Node.ELEMENT_NODE) morph(x as Element, y as Element);
		else if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue;
	});
	for (const x of was.slice(now.length)) x.remove();
}
