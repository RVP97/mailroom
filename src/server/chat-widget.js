// Mailroom's website chat widget (src/server/chat.ts). Served as /chat/<key>.js, which calls
// mailroomChat with the widget's settings. Plain JavaScript in a shadow root: no dependencies,
// nothing global but window.MailroomChat, and the page's CSS can't reach it.

// biome-ignore lint/correctness/noUnusedVariables: called by the script /chat/<key>.js serves
function mailroomChat(c) {
	var KEY = c.key;
	var registry = (window.__mailroomChats = window.__mailroomChats || {});
	if (registry[KEY]) return;
	registry[KEY] = true;

	// ── Language ───────────────────────────────────────────────────────────────

	var LANG = c.language === "es" ? "es" : "en";
	var ES = {
		Today: "Hoy",
		Yesterday: "Ayer",
		"Open chat": "Abrir chat",
		"Close chat": "Cerrar chat",
		Dismiss: "Descartar",
		"Drop to send": "Suelte para enviar",
		"Write a message…": "Escriba un mensaje…",
		Message: "Mensaje",
		"Attach a file": "Adjuntar un archivo",
		"Chats are deleted {x} after the last message.":
			"Los chats se borran {x} después del último mensaje.",
		"a year": "un año",
		" years": " años",
		"a month": "un mes",
		" months": " meses",
		" days": " días",
		"Uploading…": "Subiendo…",
		"Not sent": "No se envió",
		Retry: "Reintentar",
		"Sending…": "Enviando…",
		"Your name": "Su nombre",
		"Your email": "Su correo",
		"you@example.com": "usted@ejemplo.com",
		Start: "Empezar",
		Save: "Guardar",
		"Leave your email so we can reply even if you leave this page.":
			"Déjenos su correo para responderle aunque salga de esta página.",
		"Get our reply by email too, in case you leave:":
			"Reciba también nuestra respuesta por correo, por si sale:",
		"No thanks": "No, gracias",
		"That doesn't look like an email address.": "Ese correo no parece válido.",
		"We'll email you at ": "Le escribiremos a ",
		" if you leave.": " si sale.",
		"Start a new conversation": "Empezar otra conversación",
		"Change my email": "Cambiar mi correo",
		"Get replies by email": "Recibir respuestas por correo",
		"Email ": "Escribir a ",
		"Nothing to do here yet": "Nada por aquí todavía",
		"Sent a file": "Envió un archivo",
		"Something went wrong": "Algo falló; intente de nuevo",
		"Couldn't load the robot check": "No se pudo cargar la verificación",
		"The robot check took too long; try again":
			"La verificación tardó demasiado; intente de nuevo",
		"We couldn't check you're not a robot; try again":
			"No pudimos verificar que no es un robot; intente de nuevo",
		"Write a message first, then send files.":
			"Escriba un mensaje primero y luego envíe archivos.",
		"Files up to 10 MB, please.": "Archivos de hasta 10 MB, por favor.",
		"Reconnecting…": "Reconectando…",
		"You're offline": "Está sin conexión",
	};
	/** The server's errors, by code (its messages are in English). */
	var ES_ERRORS = {
		rate_limit_exceeded: "Va muy rápido; espere un momento.",
		chat_busy: "Ahora no podemos tomar más chats; intente más tarde.",
		unknown_chat: "Este chat terminó; empiece otro.",
		identity_required: "Inicie sesión para chatear con nosotros.",
		invalid_identity: "No pudimos confirmar su sesión; recargue la página.",
		turnstile_failed: "No pudimos verificar que no es un robot; intente de nuevo",
		origin_not_allowed: "Este sitio no puede usar este chat.",
		chat_off: "El chat está apagado.",
		too_large: "Archivos de hasta 10 MB, por favor.",
	};
	function T(s) {
		return (LANG === "es" && ES[s]) || s;
	}

	// ── Small helpers ──────────────────────────────────────────────────────────

	var STORE = "mailroom-chat:" + KEY;
	function load() {
		try {
			return JSON.parse(localStorage.getItem(STORE) || "{}") || {};
		} catch (_) {
			return {};
		}
	}
	function save(patch) {
		var s = load();
		for (var k in patch) s[k] = patch[k];
		try {
			localStorage.setItem(STORE, JSON.stringify(s));
		} catch (_) {}
		return s;
	}
	function uuid() {
		if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
		return "x" + Date.now().toString(36) + Math.random().toString(36).slice(2);
	}
	function h(tag, attrs, kids) {
		var el = document.createElement(tag);
		if (attrs)
			for (var k in attrs) {
				var v = attrs[k];
				if (v == null || v === false) continue;
				if (k === "class") el.className = v;
				else if (k === "text") el.textContent = v;
				else if (k === "html") el.innerHTML = v;
				else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
				else el.setAttribute(k, v === true ? "" : v);
			}
		if (kids)
			for (var i = 0; i < kids.length; i++)
				if (kids[i] != null)
					el.appendChild(
						typeof kids[i] === "string" ? document.createTextNode(kids[i]) : kids[i],
					);
		return el;
	}
	function svg(path, size) {
		return (
			'<svg viewBox="0 0 24 24" width="' +
			(size || 20) +
			'" height="' +
			(size || 20) +
			'" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
			path +
			"</svg>"
		);
	}
	var ICON = {
		chat: '<path d="M21 12a8 8 0 0 1-11.8 7L4 20.5l1.4-4.6A8 8 0 1 1 21 12Z"/>',
		close: '<path d="M18 6 6 18M6 6l12 12"/>',
		down: '<path d="m6 9 6 6 6-6"/>',
		send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
		clip: '<path d="m21.4 11.6-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8"/>',
		file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
		more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
		mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
		plus: '<path d="M12 5v14M5 12h14"/>',
		retry: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
		check: '<path d="M20 6 9 17l-5-5"/>',
		message:
			'<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/><path d="M8 9h8M8 13h5"/>',
		help: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
		headset:
			'<path d="M3 14v-2a9 9 0 0 1 18 0v2"/><path d="M21 15a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2ZM3 15a2 2 0 0 0 2 2h1v-6H5a2 2 0 0 0-2 2Z"/><path d="M18 17v1a3 3 0 0 1-3 3h-3"/>',
		sparkle:
			'<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z"/>',
		hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8a8 8 0 0 0 16 0v-3a2 2 0 0 0-4 0"/>',
	};
	function fmtTime(at) {
		try {
			return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
		} catch (_) {
			return "";
		}
	}
	function fmtDay(at) {
		var d = new Date(at);
		var today = new Date();
		var y = new Date();
		y.setDate(today.getDate() - 1);
		if (d.toDateString() === today.toDateString()) return T("Today");
		if (d.toDateString() === y.toDateString()) return T("Yesterday");
		return d.toLocaleDateString(LANG === "es" ? "es-MX" : [], {
			weekday: "long",
			month: "short",
			day: "numeric",
		});
	}
	function fmtSize(n) {
		if (n < 1024) return n + " B";
		if (n < 1048576) return Math.round(n / 1024) + " KB";
		return (n / 1048576).toFixed(1) + " MB";
	}
	function initial(s) {
		return ((s || "?").trim()[0] || "?").toUpperCase();
	}
	/** Text with its links made clickable (http and https only), safely. */
	function linkify(text) {
		var frag = document.createDocumentFragment();
		var re = /\b(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;
		var last = 0;
		var m;
		while ((m = re.exec(text))) {
			if (m.index > last)
				frag.appendChild(document.createTextNode(text.slice(last, m.index)));
			frag.appendChild(
				h("a", {
					href: m[1],
					target: "_blank",
					rel: "noopener noreferrer nofollow",
					text: m[1],
				}),
			);
			last = m.index + m[1].length;
		}
		if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
		return frag;
	}
	/** Black or white, whichever reads better on the accent. */
	function onColor(hex) {
		var n = parseInt(hex.slice(1), 16);
		var r = (n >> 16) & 255,
			g = (n >> 8) & 255,
			b = n & 255;
		var l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
		return l > 0.62 ? "#111827" : "#ffffff";
	}

	// ── Styles ─────────────────────────────────────────────────────────────────

	function css(cfg) {
		var side = cfg.position === "left" ? "left" : "right";
		var x = (cfg.offset_x == null ? 20 : cfg.offset_x) + "px";
		var y = (cfg.offset_y == null ? 20 : cfg.offset_y) + "px";
		return (
			":host{all:initial}" +
			"*,*::before,*::after{box-sizing:border-box}" +
			".root{--accent:" +
			cfg.color +
			";--on-accent:" +
			onColor(cfg.color) +
			";" +
			"--bg:#ffffff;--panel:#ffffff;--soft:#f3f4f6;--soft2:#e9eaee;--text:#111827;--muted:#6b7280;--line:rgba(17,24,39,.08);--shadow:0 24px 64px -12px rgba(17,24,39,.28),0 4px 16px rgba(17,24,39,.08);" +
			"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:15px;line-height:1.45;color:var(--text);-webkit-font-smoothing:antialiased;}" +
			".root.dark{--bg:#111318;--panel:#16181e;--soft:#22252d;--soft2:#2b2f38;--text:#f3f4f6;--muted:#9ca3af;--line:rgba(255,255,255,.08);--shadow:0 24px 64px -12px rgba(0,0,0,.6),0 4px 16px rgba(0,0,0,.4)}" +
			"button,input,textarea{font:inherit;color:inherit}" +
			"button{cursor:pointer;border:0;background:none;padding:0}" +
			":focus-visible{outline:2px solid var(--accent);outline-offset:2px}" +
			// Launcher
			".launcher{position:fixed;" +
			side +
			":" +
			x +
			";bottom:" +
			y +
			";z-index:2147483000;display:flex;align-items:center;justify-content:center;gap:8px;height:56px;min-width:56px;border-radius:28px;background:var(--accent);color:var(--on-accent);box-shadow:0 8px 24px -6px rgba(17,24,39,.35),0 2px 6px rgba(17,24,39,.12);transition:transform .2s cubic-bezier(.2,.8,.2,1),box-shadow .2s}" +
			".launcher:hover{transform:scale(1.05)}.launcher:active{transform:scale(.97)}" +
			".launcher.label{padding:0 20px 0 16px;font-weight:600;font-size:15px}" +
			".launcher .ic{display:grid;place-items:center;width:26px;height:26px;position:relative}" +
			".launcher .ic span{position:absolute;inset:0;display:grid;place-items:center;transition:transform .25s cubic-bezier(.2,.8,.2,1),opacity .2s}" +
			".launcher .ic .b{opacity:0;transform:rotate(-90deg) scale(.6)}" +
			".open .launcher .ic .a{opacity:0;transform:rotate(90deg) scale(.6)}.open .launcher .ic .b{opacity:1;transform:none}" +
			".open .launcher.label{padding:0;width:56px}.open .launcher.label .lt{display:none}" +
			".badge{position:absolute;top:-4px;" +
			(side === "right" ? "right" : "left") +
			":-4px;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:#ef4444;color:#fff;font-size:12px;font-weight:700;display:none;align-items:center;justify-content:center;box-shadow:0 0 0 2px var(--bg)}" +
			".badge.on{display:flex}" +
			// Nudge (a new reply while closed)
			".nudge{position:fixed;" +
			side +
			":" +
			x +
			";bottom:calc(" +
			y +
			" + 68px);z-index:2147483000;width:min(320px,calc(100vw - 32px));background:var(--panel);color:var(--text);border-radius:14px;box-shadow:var(--shadow);padding:14px 16px;display:none;gap:10px;align-items:flex-start;text-align:left;animation:pop .25s cubic-bezier(.2,.8,.2,1)}" +
			".nudge.on{display:flex}.nudge .who{font-size:13px;font-weight:600}.nudge .what{font-size:14px;color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}" +
			".nudge .x{position:absolute;top:6px;" +
			(side === "right" ? "right" : "left") +
			":6px;color:var(--muted);width:24px;height:24px;border-radius:6px;display:grid;place-items:center}.nudge .x:hover{background:var(--soft)}" +
			// Panel
			".panel{position:fixed;" +
			side +
			":" +
			x +
			";bottom:calc(" +
			y +
			" + 72px);z-index:2147483000;width:380px;height:min(640px,calc(100vh - " +
			(parseInt(y, 10) + 96) +
			"px));max-height:calc(100vh - 32px);background:var(--panel);border-radius:18px;box-shadow:var(--shadow);display:flex;flex-direction:column;overflow:hidden;transform-origin:bottom " +
			side +
			";opacity:0;transform:translateY(12px) scale(.96);pointer-events:none;visibility:hidden;transition:opacity .2s ease,transform .25s cubic-bezier(.2,.8,.2,1),visibility 0s .25s}" +
			".open .panel{opacity:1;transform:none;pointer-events:auto;visibility:visible;transition:opacity .2s ease,transform .25s cubic-bezier(.2,.8,.2,1)}" +
			"@media (max-width:480px){.panel{inset:0;width:100%;height:100%;max-height:none;border-radius:0;bottom:0;" +
			side +
			":0}.open .launcher{display:none}.nudge{" +
			side +
			":12px}}" +
			"@media (prefers-reduced-motion:reduce){.panel,.launcher,.launcher .ic span{transition:none!important}.nudge,.msg{animation:none!important}}" +
			// Header
			".head{background:var(--accent);color:var(--on-accent);padding:16px 12px 16px 16px;display:flex;align-items:center;gap:12px;flex:none;padding-top:max(16px,env(safe-area-inset-top))}" +
			".logo{width:40px;height:40px;border-radius:12px;background:rgba(255,255,255,.18);display:grid;place-items:center;font-weight:700;font-size:17px;flex:none;overflow:hidden}" +
			".logo img{width:100%;height:100%;object-fit:contain;background:#fff}" +
			".ht{min-width:0;flex:1}.ht b{display:block;font-size:16px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.005em}.ht small{display:flex;align-items:center;gap:6px;font-size:13px;opacity:.85;white-space:nowrap;overflow:hidden;padding:2px 0 2px 2px}.ht small span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis}" +
			".dot{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 2px rgba(255,255,255,.35);flex:none}" +
			".hb{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;color:inherit;opacity:.9;flex:none}.hb:hover{background:rgba(255,255,255,.16);opacity:1}" +
			".menu{position:absolute;top:64px;" +
			(side === "right" ? "right" : "left") +
			":12px;background:var(--panel);color:var(--text);border-radius:12px;box-shadow:var(--shadow);padding:6px;min-width:220px;display:none;z-index:2}" +
			".menu.on{display:block}.menu button{display:flex;gap:10px;align-items:center;width:100%;padding:9px 10px;border-radius:8px;font-size:14px;text-align:left}.menu button:hover{background:var(--soft)}" +
			// Body
			".body{flex:1;overflow-y:auto;padding:16px 14px 8px;display:flex;flex-direction:column;gap:2px;overscroll-behavior:contain;background:var(--bg);position:relative}" +
			".banner{position:sticky;top:-16px;margin:-16px -14px 8px;padding:6px 12px;font-size:12.5px;text-align:center;background:var(--soft);color:var(--muted);display:none;z-index:1}.banner.on{display:block}" +
			".day{align-self:center;font-size:12px;color:var(--muted);margin:14px 0 8px;font-weight:500}" +
			".sys{align-self:center;max-width:88%;font-size:13px;color:var(--muted);text-align:center;margin:10px 0;padding:8px 12px;border-radius:12px;background:var(--soft)}" +
			".grp{display:flex;gap:8px;align-items:flex-end;margin-top:10px;max-width:100%}" +
			".grp.me{flex-direction:row-reverse}" +
			".av{width:28px;height:28px;border-radius:50%;background:var(--soft2);color:var(--text);display:grid;place-items:center;font-size:12px;font-weight:700;flex:none;overflow:hidden}" +
			".av img{width:100%;height:100%;object-fit:contain;background:#fff}" +
			".col{display:flex;flex-direction:column;gap:3px;min-width:0;max-width:78%}.me .col{align-items:flex-end}" +
			".name{font-size:12px;color:var(--muted);margin:0 0 2px 4px;font-weight:500}" +
			".msg{padding:9px 13px;border-radius:18px;background:var(--soft);white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;animation:pop .22s cubic-bezier(.2,.8,.2,1);max-width:100%}" +
			".msg a{color:inherit;text-decoration:underline;text-underline-offset:2px}" +
			".me .msg{background:var(--accent);color:var(--on-accent)}" +
			".grp:not(.me) .msg:not(:last-of-type){border-bottom-left-radius:6px}.grp:not(.me) .msg+.msg,.grp:not(.me) .msg+.file,.grp:not(.me) .file+.msg{border-top-left-radius:6px}" +
			".me .msg:not(:last-of-type){border-bottom-right-radius:6px}.me .msg+.msg,.me .msg+.file,.me .file+.msg{border-top-right-radius:6px}" +
			".msg.pending{opacity:.6}.msg.failed{background:#fee2e2;color:#991b1b}" +
			".img{display:block;border-radius:14px;overflow:hidden;max-width:240px;background:var(--soft);line-height:0}.img img{max-width:240px;max-height:260px;width:auto;height:auto;display:block}" +
			".file{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:14px;background:var(--soft);color:var(--text);text-decoration:none;max-width:260px}.file:hover{background:var(--soft2)}" +
			".file .fi{width:34px;height:34px;border-radius:9px;background:var(--panel);display:grid;place-items:center;flex:none;color:var(--muted)}" +
			".file b{display:block;font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}.file small{font-size:12px;color:var(--muted)}" +
			".meta{font-size:11.5px;color:var(--muted);margin:2px 6px 0;display:flex;gap:6px;align-items:center}" +
			".meta button{color:#dc2626;font-weight:600;display:inline-flex;gap:4px;align-items:center}" +
			".typing{display:flex;gap:4px;padding:13px 14px;border-radius:18px;background:var(--soft);width:max-content}" +
			".typing i{width:7px;height:7px;border-radius:50%;background:var(--muted);opacity:.5;animation:blink 1.2s infinite}.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}" +
			"@keyframes blink{0%,60%,100%{opacity:.25;transform:translateY(0)}30%{opacity:.9;transform:translateY(-3px)}}" +
			"@keyframes pop{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}" +
			// Cards
			".card{margin:12px 2px 4px;padding:14px;border-radius:14px;background:var(--panel);box-shadow:0 0 0 1px var(--line),0 4px 14px -6px rgba(17,24,39,.12)}" +
			".card p{margin:0 0 10px;font-size:14px}.card .row{display:flex;gap:8px}.card .done{display:flex;gap:8px;align-items:center;font-size:13.5px;color:var(--muted)}.card .done b{color:var(--text);font-weight:600}" +
			".card .link{color:var(--accent);font-weight:600;font-size:13px}" +
			".in{flex:1;min-width:0;height:40px;padding:0 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);outline:none;font-size:14.5px}.in:focus-visible{outline:0}.in:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}" +
			".btn{height:40px;padding:0 14px;border-radius:10px;background:var(--accent);color:var(--on-accent);font-weight:600;font-size:14px;flex:none}.btn:disabled{opacity:.5;cursor:default}" +
			".stack{display:flex;flex-direction:column;gap:8px}" +
			".err{color:#dc2626;font-size:12.5px;margin-top:6px;display:none}.err.on{display:block}" +
			// Composer
			".foot{flex:none;border-top:1px solid var(--line);background:var(--panel);padding:10px 10px max(10px,env(safe-area-inset-bottom))}" +
			".box{display:flex;align-items:flex-end;gap:6px;background:var(--bg);border:1px solid var(--line);border-radius:16px;padding:6px 6px 6px 12px;transition:border-color .15s,box-shadow .15s}" +
			".box:focus-within{border-color:color-mix(in srgb,var(--accent) 60%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 16%,transparent)}" +
			"textarea,textarea:focus-visible{flex:1;min-width:0;border:0;outline:0;background:transparent;resize:none;padding:7px 0;max-height:132px;font-size:15px;line-height:1.4}" +
			"textarea::placeholder,.in::placeholder{color:var(--muted)}" +
			".tool{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;color:var(--muted);flex:none}.tool:hover{background:var(--soft);color:var(--text)}" +
			".send{width:36px;height:36px;border-radius:11px;display:grid;place-items:center;background:var(--accent);color:var(--on-accent);flex:none;transition:opacity .15s,transform .15s}.send:disabled{opacity:.35;cursor:default}.send:not(:disabled):active{transform:scale(.94)}" +
			".note{font-size:11.5px;color:var(--muted);text-align:center;margin-top:8px}" +
			".note a{color:inherit}" +
			".drop{position:absolute;inset:8px;border-radius:14px;border:2px dashed var(--accent);background:color-mix(in srgb,var(--accent) 8%,var(--panel));display:none;place-items:center;font-weight:600;color:var(--accent);z-index:3}.drop.on{display:grid}" +
			".ts{margin:8px auto 0;display:none}.ts.on{display:block}" +
			".sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}" +
			extras(cfg) +
			// The brand's own CSS goes last (it only reaches inside the widget).
			(cfg.custom_css ? String(cfg.custom_css) : "")
		);
	}

	var FONTS = {
		system: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif",
		rounded:
			"ui-rounded,'SF Pro Rounded','Nunito','Varela Round','Quicksand',-apple-system,'Segoe UI',sans-serif",
		serif: "ui-serif,Georgia,'Iowan Old Style','Palatino Linotype',Cambria,serif",
		mono: "ui-monospace,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace",
	};
	/** The site's own font (the widget's styles don't inherit it). */
	function siteFont() {
		try {
			return (
				getComputedStyle(document.body || document.documentElement).fontFamily ||
				FONTS.system
			);
		} catch (_) {
			return FONTS.system;
		}
	}
	/** Hex to "r,g,b" for rgba(). */
	function rgb(hex) {
		var n = parseInt(String(hex || "#2563eb").slice(1), 16);
		return ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255);
	}

	/** The look's choices over the base styles: corners, header, background, type, sizes. */
	function extras(cfg) {
		var out = "";
		// Corners: the panel's radius; bubbles, fields and buttons follow it.
		var R = {
			square: [4, 6, 4, 8],
			soft: [12, 12, 8, 14],
			rounded: [18, 18, 10, 28],
			pill: [26, 22, 20, 999],
		}[cfg.corners || "rounded"] || [18, 18, 10, 28];
		out +=
			"@media (min-width:481px){.panel{border-radius:" +
			R[0] +
			"px}}" +
			".msg,.typing{border-radius:" +
			R[1] +
			"px}" +
			".grp:not(.me) .msg:not(:last-of-type){border-bottom-left-radius:" +
			Math.min(6, R[1]) +
			"px}" +
			".me .msg:not(:last-of-type){border-bottom-right-radius:" +
			Math.min(6, R[1]) +
			"px}" +
			".in,.btn,.hb,.tool,.send,.logo{border-radius:" +
			R[2] +
			"px}" +
			".box{border-radius:" +
			Math.min(R[2] + 6, 28) +
			"px}" +
			".card,.file,.img,.nudge,.menu,.sys{border-radius:" +
			Math.min(R[1], 16) +
			"px}" +
			".launcher{border-radius:" +
			R[3] +
			"px}";
		// Sizes.
		var L = { small: 48, medium: 56, large: 64 }[cfg.launcher_size || "medium"] || 56;
		out +=
			".launcher{height:" +
			L +
			"px;min-width:" +
			L +
			"px}" +
			".open .launcher.label{width:" +
			L +
			"px}" +
			"@media (min-width:481px){.panel{bottom:calc(" +
			(cfg.offset_y == null ? 20 : cfg.offset_y) +
			"px + " +
			(L + 16) +
			"px)}}" +
			".nudge{bottom:calc(" +
			(cfg.offset_y == null ? 20 : cfg.offset_y) +
			"px + " +
			(L + 12) +
			"px)}";
		var W = { compact: [340, 560], regular: [380, 640], wide: [440, 720] }[
			cfg.width || "regular"
		] || [380, 640];
		out +=
			"@media (min-width:481px){.panel{width:" +
			W[0] +
			"px;height:min(" +
			W[1] +
			"px,calc(100vh - " +
			((cfg.offset_y == null ? 20 : cfg.offset_y) + L + 40) +
			"px))}}";
		var T = { small: 14, medium: 15, large: 16.5 }[cfg.text_size || "medium"] || 15;
		out +=
			".root{font-size:" +
			T +
			"px}textarea{font-size:" +
			Math.max(T, 16) +
			"px}@media (min-width:481px){textarea{font-size:" +
			T +
			"px}}";
		// Type.
		var font = cfg.font === "site" ? siteFont() : FONTS[cfg.font] || FONTS.system;
		out += ".root{font-family:" + font + "}";
		// Header.
		if (cfg.header === "gradient")
			out +=
				".head{background:linear-gradient(135deg," +
				cfg.color +
				" 0%," +
				(cfg.color2 || cfg.color) +
				" 100%)}" +
				(cfg.color2
					? ""
					: ".head{background:linear-gradient(135deg," +
						cfg.color +
						",color-mix(in srgb," +
						cfg.color +
						" 55%,#000))}");
		else if (cfg.header === "plain")
			out +=
				".head{background:var(--panel);color:var(--text);border-bottom:1px solid var(--line)}" +
				".head .logo{background:var(--accent);color:var(--on-accent)}" +
				".head .hb:hover{background:var(--soft)}.head .dot{box-shadow:0 0 0 2px var(--panel)}";
		// The conversation's background.
		var tint = "rgba(" + rgb(cfg.color) + ",";
		if (cfg.background === "tint")
			out +=
				".body{background:linear-gradient(180deg," +
				tint +
				".08)," +
				tint +
				".02) 60%),var(--bg)}";
		else if (cfg.background === "dots")
			out +=
				".body{background-color:var(--bg);background-image:radial-gradient(" +
				tint +
				".22) 1px,transparent 1.2px);background-size:16px 16px}";
		else if (cfg.background === "grid")
			out +=
				".body{background-color:var(--bg);background-image:linear-gradient(" +
				tint +
				".08) 1px,transparent 1px),linear-gradient(90deg," +
				tint +
				".08) 1px,transparent 1px);background-size:22px 22px}";
		else if (cfg.background === "gradient")
			out +=
				".body{background:radial-gradient(120% 60% at 50% 0%," +
				tint +
				".16),transparent 70%),var(--bg)}";
		// The visitor's bubbles.
		if (cfg.bubbles === "soft")
			out +=
				".me .msg{background:color-mix(in srgb,var(--accent) 16%,var(--panel));color:var(--text)}";
		else if (cfg.bubbles === "outline")
			out +=
				".me .msg{background:transparent;color:var(--text);box-shadow:inset 0 0 0 1.5px var(--accent)}";
		// The team's bubbles.
		if (cfg.team_bubbles === "outline")
			out +=
				".grp:not(.me) .msg,.typing{background:var(--panel);box-shadow:inset 0 0 0 1px var(--line)}";
		else if (cfg.team_bubbles === "accent")
			out +=
				".grp:not(.me) .msg{background:color-mix(in srgb,var(--accent) 10%,var(--panel))}";
		// Depth.
		if (cfg.shadow === "none")
			out += ".panel,.nudge{box-shadow:0 0 0 1px var(--line)}.launcher{box-shadow:none}";
		else if (cfg.shadow === "strong")
			out +=
				".panel{box-shadow:0 40px 90px -16px rgba(0,0,0,.45),0 8px 24px rgba(0,0,0,.18)}";
		// Showing it.
		if (cfg.launcher === "hidden") out += ".launcher{display:none!important}";
		if (cfg.hide_mobile)
			out += "@media (max-width:480px){.launcher,.nudge{display:none!important}}";
		if (cfg.z_index) out += ".launcher,.panel,.nudge{z-index:" + (cfg.z_index | 0) + "}";
		return out;
	}

	// ── The widget ─────────────────────────────────────────────────────────────

	var cfg = c;
	var state = {
		open: false,
		messages: [],
		conversation: null,
		typing: null,
		unread: 0,
		sending: false,
		online: true,
		ws: null,
		wsTries: 0,
		poll: null,
		awayShown: false,
	};
	var stored = load();
	/** The website's signed identity token (identity verification), when it gave one. */
	var preset = window.MailroomChatSettings || {};
	var identity = typeof preset.identity === "string" ? preset.identity : null;
	var verified = () =>
		!!identity ||
		!!(state.conversation && state.conversation.visitor && state.conversation.visitor.verified);
	var opener = null;
	var dark =
		cfg.theme === "dark" ||
		(cfg.theme !== "light" &&
			window.matchMedia &&
			matchMedia("(prefers-color-scheme: dark)").matches);

	var host = h("div", { id: "mailroom-chat-" + KEY, "data-mailroom-chat": "" });
	host.style.cssText = "position:fixed;z-index:2147483000;inset:auto";
	var shadow = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
	var style = h("style", { text: css(cfg) });
	var root = h("div", { class: "root" + (dark ? " dark" : "") });
	shadow.appendChild(style);
	shadow.appendChild(root);

	// Launcher
	/** The launcher's icon (the brand's logo, or one of a few), and the arrow it turns into. */
	function launcherIcon() {
		var mark = cfg.brand_logo || cfg.logo;
		var a =
			cfg.launcher_icon === "logo" && mark
				? '<img src="' +
					String(mark).replace(/"/g, "&quot;") +
					'" alt="" style="width:30px;height:30px;border-radius:50%;object-fit:cover;background:#fff">'
				: svg(ICON[cfg.launcher_icon] || ICON.chat, 24);
		return '<span class="a">' + a + '</span><span class="b">' + svg(ICON.down, 26) + "</span>";
	}
	var badge = h("span", { class: "badge", "aria-hidden": "true" });
	var launcher = h(
		"button",
		{
			class: "launcher" + (cfg.launcher === "label" ? " label" : ""),
			type: "button",
			"aria-label": T("Open chat"),
			"aria-expanded": "false",
			onclick: () => {
				toggle();
			},
		},
		[
			h("span", { class: "ic", html: launcherIcon() }),
			cfg.launcher === "label"
				? h("span", { class: "lt", text: cfg.launcher_text || "Chat" })
				: null,
			badge,
		],
	);

	// Nudge
	var nudgeWho = h("div", { class: "who" });
	var nudgeWhat = h("div", { class: "what" });
	var nudgeAv = h("div", { class: "av" });
	var nudge = h("div", { class: "nudge", role: "status" }, [
		nudgeAv,
		h(
			"button",
			{
				type: "button",
				style: "text-align:left;flex:1;min-width:0",
				onclick: () => {
					openPanel();
				},
			},
			[nudgeWho, nudgeWhat],
		),
		h("button", {
			class: "x",
			type: "button",
			"aria-label": T("Dismiss"),
			html: svg(ICON.close, 14),
			onclick: () => {
				nudge.classList.remove("on");
			},
		}),
	]);

	// Panel
	function logoEl(cls) {
		var el = h("div", { class: cls });
		if (cfg.logo) el.appendChild(h("img", { src: cfg.logo, alt: "" }));
		else el.textContent = initial(cfg.title);
		return el;
	}
	var statusLine = h("small", null, [
		h("span", { class: "dot", "aria-hidden": "true" }),
		h("span", { text: cfg.subtitle || "" }),
	]);
	var menu = h("div", { class: "menu", role: "menu" });
	var menuBtn = h("button", {
		class: "hb",
		type: "button",
		"aria-label": "More",
		"aria-haspopup": "menu",
		html: svg(ICON.more),
		onclick: (e) => {
			e.stopPropagation();
			buildMenu();
			menu.classList.toggle("on");
		},
	});
	var head = h("div", { class: "head" }, [
		logoEl("logo"),
		h("div", { class: "ht" }, [h("b", { text: cfg.title }), cfg.subtitle ? statusLine : null]),
		menuBtn,
		h("button", {
			class: "hb",
			type: "button",
			"aria-label": T("Close chat"),
			html: svg(ICON.down, 22),
			onclick: () => {
				closePanel();
			},
		}),
	]);
	var banner = h("div", { class: "banner", role: "status" });
	var list = h("div", { role: "log", "aria-live": "polite", "aria-relevant": "additions" });
	list.style.cssText = "display:flex;flex-direction:column;gap:2px";
	var typingRow = h("div");
	var cards = h("div");
	var tsBox = h("div", { class: "ts" });
	var body = h("div", { class: "body" }, [banner, list, typingRow, cards, tsBox]);
	var drop = h("div", { class: "drop", text: T("Drop to send") });
	var input = h("textarea", {
		rows: "1",
		placeholder: cfg.placeholder || T("Write a message…"),
		"aria-label": T("Message"),
		maxlength: "4000",
	});
	var fileInput = h("input", {
		type: "file",
		accept: "image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip",
		style: "display:none",
	});
	var sendBtn = h("button", {
		class: "send",
		type: "submit",
		"aria-label": "Send",
		html: svg(ICON.send, 18),
		disabled: true,
	});
	var attachBtn = cfg.files
		? h("button", {
				class: "tool",
				type: "button",
				"aria-label": T("Attach a file"),
				html: svg(ICON.clip),
				onclick: () => {
					fileInput.click();
				},
			})
		: null;
	var form = h("form", { class: "box" }, [input, attachBtn, sendBtn]);
	var note = h("div", { class: "note" });
	var foot = h("div", { class: "foot" }, [form, note, fileInput]);
	var panel = h(
		"div",
		{
			class: "panel",
			role: "dialog",
			"aria-label": cfg.title + " chat",
			"aria-modal": "false",
		},
		[head, menu, body, foot, drop],
	);
	root.appendChild(nudge);
	root.appendChild(panel);
	root.appendChild(launcher);

	if (cfg.retention)
		note.textContent = T("Chats are deleted {x} after the last message.").replace(
			"{x}",
			retentionText(cfg.retention),
		);
	function retentionText(days) {
		if (days % 365 === 0) return days / 365 === 1 ? T("a year") : days / 365 + T(" years");
		if (days % 30 === 0) return days / 30 === 1 ? T("a month") : days / 30 + T(" months");
		return days + T(" days");
	}

	// ── Rendering ──────────────────────────────────────────────────────────────

	var FIVE_MIN = 5 * 60 * 1000;

	function greetingMessage() {
		return cfg.greeting
			? {
					id: "greeting",
					author: "team",
					name: null,
					text: cfg.greeting,
					files: [],
					at: null,
					greeting: true,
				}
			: null;
	}

	function render() {
		list.textContent = "";
		var msgs = state.messages.slice();
		var g = greetingMessage();
		if (g) msgs.unshift(g);
		var lastDay = null;
		var grp = null;
		var prev = null;
		for (var i = 0; i < msgs.length; i++) {
			var m = msgs[i];
			if (m.author === "system") {
				list.appendChild(h("div", { class: "sys", text: m.text }));
				grp = null;
				prev = null;
				continue;
			}
			if (m.at) {
				var day = new Date(m.at).toDateString();
				if (
					day !== lastDay &&
					(lastDay !== null || i > (g ? 1 : 0) || state.messages.length > 0)
				) {
					if (lastDay !== day)
						list.appendChild(h("div", { class: "day", text: fmtDay(m.at) }));
					grp = null;
				}
				lastDay = day;
			}
			var mine = m.author === "visitor";
			var same =
				grp &&
				prev &&
				prev.author === m.author &&
				(prev.name || "") === (m.name || "") &&
				(!m.at || !prev.at || new Date(m.at) - new Date(prev.at) < FIVE_MIN);
			if (!same) {
				var col = h("div", { class: "col" });
				var av = null;
				if (!mine) {
					av = m.name ? h("div", { class: "av", text: initial(m.name) }) : logoEl("av");
					col.appendChild(h("div", { class: "name", text: m.name || cfg.title }));
				}
				grp = h("div", { class: "grp" + (mine ? " me" : "") }, [av, col]);
				grp._col = col;
				list.appendChild(grp);
			}
			var colEl = grp._col;
			var old = colEl.querySelector(".meta");
			if (old) old.remove();
			if (m.text) {
				var b = h("div", {
					class: "msg" + (m.pending ? " pending" : "") + (m.failed ? " failed" : ""),
				});
				b.appendChild(linkify(m.text));
				colEl.appendChild(b);
			}
			for (var j = 0; j < (m.files || []).length; j++)
				colEl.appendChild(fileEl(m.files[j], m));
			var meta = metaFor(m);
			if (meta) colEl.appendChild(meta);
			prev = m;
		}
		renderTyping();
		renderCards();
		scrollDown();
	}

	function fileEl(f, m) {
		if (f.image && f.url)
			return h(
				"a",
				{ class: "img", href: f.url, target: "_blank", rel: "noopener noreferrer" },
				[h("img", { src: f.url, alt: f.filename, loading: "lazy", onload: scrollDown })],
			);
		return h(
			f.url ? "a" : "div",
			{
				class: "file" + (m.pending ? " pending" : ""),
				href: f.url || null,
				target: f.url ? "_blank" : null,
				rel: "noopener noreferrer",
			},
			[
				h("span", { class: "fi", html: svg(ICON.file, 18) }),
				h("span", { style: "min-width:0" }, [
					h("b", { text: f.filename }),
					h("small", { text: m.pending ? T("Uploading…") : fmtSize(f.size || 0) }),
				]),
			],
		);
	}

	function metaFor(m) {
		if (m.greeting) return null;
		if (m.failed)
			return h("div", { class: "meta" }, [
				h("span", { text: m.error || T("Not sent") }),
				h("button", {
					type: "button",
					html: svg(ICON.retry, 12) + T("Retry"),
					onclick: () => {
						retry(m);
					},
				}),
			]);
		if (m.pending) return h("div", { class: "meta", text: T("Sending…") });
		return m.at ? h("div", { class: "meta", text: fmtTime(m.at) }) : null;
	}

	function renderTyping() {
		typingRow.textContent = "";
		if (!state.typing) return;
		var who = state.typing.name;
		typingRow.appendChild(
			h("div", { class: "grp" }, [
				who ? h("div", { class: "av", text: initial(who) }) : logoEl("av"),
				h("div", { class: "col" }, [
					h("span", { class: "sr", text: (who || cfg.title) + " is typing" }),
					h("div", { class: "typing", "aria-hidden": "true" }, [h("i"), h("i"), h("i")]),
				]),
			]),
		);
	}

	var needEmail = () =>
		cfg.ask_email === "required" && !state.conversation && !stored.email && !verified();

	function renderCards() {
		cards.textContent = "";
		if (cfg.preview || verified()) return;
		if (needEmail()) {
			cards.appendChild(emailCard(true));
			return;
		}
		var visitorWrote = state.messages.some((m) => m.author === "visitor" && !m.failed);
		if (cfg.ask_email !== "off" && visitorWrote && state.conversation) {
			var email = state.conversation.visitor && state.conversation.visitor.email;
			if (!email && !stored.emailDismissed) cards.appendChild(emailCard(false));
			else if (email && stored.emailJustSaved) cards.appendChild(savedCard(email));
		}
	}

	function emailCard(before) {
		var name = cfg.ask_name
			? h("input", {
					class: "in",
					type: "text",
					placeholder: T("Your name"),
					autocomplete: "name",
					"aria-label": T("Your name"),
				})
			: null;
		var email = h("input", {
			class: "in",
			type: "email",
			placeholder: T("you@example.com"),
			autocomplete: "email",
			required: true,
			"aria-label": T("Your email"),
		});
		var err = h("div", { class: "err" });
		var btn = h("button", {
			class: "btn",
			type: "submit",
			text: before ? T("Start") : T("Save"),
		});
		var f = h("form", { class: "card" }, [
			h("p", {
				text: before
					? T("Leave your email so we can reply even if you leave this page.")
					: T("Get our reply by email too, in case you leave:"),
			}),
			h("div", { class: "stack" }, [name, h("div", { class: "row" }, [email, btn])]),
			err,
			!before
				? h("button", {
						type: "button",
						class: "link",
						style: "margin-top:8px",
						text: T("No thanks"),
						onclick: () => {
							stored = save({ emailDismissed: true });
							renderCards();
						},
					})
				: null,
		]);
		f.addEventListener("submit", (e) => {
			e.preventDefault();
			var v = email.value.trim();
			if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
				err.textContent = T("That doesn't look like an email address.");
				err.classList.add("on");
				return;
			}
			var nm = name ? name.value.trim() : null;
			if (before) {
				stored = save({ email: v, name: nm || stored.name || null });
				renderCards();
				setComposer();
				input.focus();
				return;
			}
			btn.disabled = true;
			api("POST", "/profile", { email: v, name: nm || undefined })
				.then((r) => {
					state.conversation = r.conversation;
					stored = save({ email: v, emailJustSaved: true });
					renderCards();
				})
				.catch((e2) => {
					btn.disabled = false;
					err.textContent = e2.message;
					err.classList.add("on");
				});
		});
		return f;
	}

	function savedCard(email) {
		return h("div", { class: "card" }, [
			h("div", { class: "done" }, [
				h("span", { html: svg(ICON.mail, 18) }),
				h("span", null, [
					T("We'll email you at "),
					h("b", { text: email }),
					T(" if you leave."),
				]),
			]),
		]);
	}

	function buildMenu() {
		menu.textContent = "";
		var items = [];
		if (state.conversation)
			items.push({
				icon: ICON.plus,
				text: T("Start a new conversation"),
				run: () => {
					newConversation();
				},
			});
		if (state.conversation && cfg.ask_email !== "off" && !verified())
			items.push({
				icon: ICON.mail,
				text:
					state.conversation.visitor && state.conversation.visitor.email
						? T("Change my email")
						: T("Get replies by email"),
				run: () => {
					stored = save({ emailDismissed: false, emailJustSaved: false });
					if (state.conversation.visitor) state.conversation.visitor.email = null;
					renderCards();
					scrollDown();
				},
			});
		if (cfg.address)
			items.push({
				icon: ICON.mail,
				text: T("Email ") + cfg.address,
				run: () => {
					window.open("mailto:" + cfg.address, "_blank");
				},
			});
		if (!items.length)
			items.push({ icon: ICON.check, text: T("Nothing to do here yet"), run: () => {} });
		for (var i = 0; i < items.length; i++)
			((it) => {
				menu.appendChild(
					h(
						"button",
						{
							type: "button",
							role: "menuitem",
							onclick: () => {
								menu.classList.remove("on");
								it.run();
							},
						},
						[h("span", { html: svg(it.icon, 18) }), h("span", { text: it.text })],
					),
				);
			})(items[i]);
	}
	document.addEventListener("click", () => {
		menu.classList.remove("on");
	});
	panel.addEventListener("click", (e) => {
		if (!menu.contains(e.target) && e.target !== menuBtn) menu.classList.remove("on");
	});

	function scrollDown() {
		requestAnimationFrame(() => {
			body.scrollTop = body.scrollHeight;
		});
	}

	function setComposer() {
		var blocked = needEmail();
		input.disabled = blocked;
		if (attachBtn) attachBtn.disabled = blocked || !state.conversation;
		if (attachBtn) attachBtn.style.display = state.conversation || cfg.preview ? "" : "none";
		sendBtn.disabled = blocked || !input.value.trim() || state.sending;
	}

	function setBanner(text) {
		banner.textContent = text || "";
		banner.classList.toggle("on", !!text);
	}

	// ── Opening and closing ────────────────────────────────────────────────────

	function openPanel() {
		if (state.open) return;
		state.open = true;
		opener = document.activeElement;
		root.classList.add("open");
		launcher.setAttribute("aria-expanded", "true");
		launcher.setAttribute("aria-label", T("Close chat"));
		nudge.classList.remove("on");
		setUnread(0);
		render();
		setComposer();
		if (stored.token && !cfg.preview) {
			refresh();
			connect();
		}
		setTimeout(() => {
			if (window.innerWidth > 480) input.focus();
		}, 120);
		markSeen();
		if (window.innerWidth <= 480) lockScroll(true);
		emit("open");
	}
	function closePanel() {
		if (!state.open) return;
		state.open = false;
		root.classList.remove("open");
		launcher.setAttribute("aria-expanded", "false");
		launcher.setAttribute("aria-label", T("Open chat"));
		menu.classList.remove("on");
		lockScroll(false);
		stopTyping();
		// Back to what opened it: the launcher, or the page's own button when there's none.
		if (cfg.launcher === "hidden" && opener && opener.focus && document.contains(opener))
			opener.focus();
		else launcher.focus();
		emit("close");
	}
	function toggle() {
		if (state.open) closePanel();
		else openPanel();
	}
	var savedOverflow = null;
	function lockScroll(on) {
		if (on && savedOverflow === null) {
			savedOverflow = document.documentElement.style.overflow;
			document.documentElement.style.overflow = "hidden";
		} else if (!on && savedOverflow !== null) {
			document.documentElement.style.overflow = savedOverflow;
			savedOverflow = null;
		}
	}
	panel.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			e.stopPropagation();
			closePanel();
		}
	});

	function setUnread(n) {
		var was = state.unread;
		state.unread = n;
		badge.textContent = n > 9 ? "9+" : String(n);
		badge.classList.toggle("on", n > 0);
		if (was !== n) emit("unread", { count: n });
	}
	/** Tells the page: mailroom-chat:open, :close, :unread ({ count }) on window. */
	function emit(name, detail) {
		try {
			window.dispatchEvent(
				new CustomEvent("mailroom-chat:" + name, { detail: detail || {} }),
			);
		} catch (_) {}
	}

	function showNudge(m) {
		if (state.open || cfg.preview) return;
		nudgeAv.textContent = "";
		if (m.name) nudgeAv.textContent = initial(m.name);
		else {
			var l = logoEl("av");
			nudgeAv.appendChild(l.firstChild || document.createTextNode(initial(cfg.title)));
		}
		nudgeWho.textContent = m.name || cfg.title;
		nudgeWhat.textContent = m.text || (m.files && m.files.length ? T("Sent a file") : "");
		nudge.classList.add("on");
	}

	// ── Talking to Mailroom ────────────────────────────────────────────────────

	function api(method, path, body, isForm) {
		var headers = {};
		if (stored.token) headers.authorization = "Bearer " + stored.token;
		if (body && !isForm) headers["content-type"] = "application/json";
		return fetch(cfg.api + path, {
			method: method,
			headers: headers,
			body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
			credentials: "omit",
			mode: "cors",
		}).then((r) =>
			r
				.json()
				.catch(() => ({}))
				.then((j) => {
					if (!r.ok) {
						var code = j.error && j.error.code;
						var e = new Error(
							(LANG === "es" && code && ES_ERRORS[code]) ||
								(j.error && j.error.message) ||
								T("Something went wrong"),
						);
						e.status = r.status;
						e.code = j.error && j.error.code;
						throw e;
					}
					return j;
				}),
		);
	}

	function merge(list2) {
		for (var i = 0; i < list2.length; i++) add(list2[i], true);
		render();
	}

	/** Adds a line (or replaces its pending copy); true when it's new. */
	function add(m, quiet) {
		for (var i = 0; i < state.messages.length; i++) {
			var x = state.messages[i];
			if (x.id === m.id || (m.client_id && x.client_id === m.client_id)) {
				state.messages[i] = m;
				if (!quiet) render();
				return false;
			}
		}
		state.messages.push(m);
		state.messages.sort((a, b) => {
			if (!a.at) return 1;
			if (!b.at) return -1;
			return a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
		});
		if (!quiet) render();
		return true;
	}

	function lastId() {
		for (var i = state.messages.length - 1; i >= 0; i--)
			if (!state.messages[i].pending && !state.messages[i].failed && !state.messages[i].local)
				return state.messages[i].id;
		return null;
	}

	function refresh() {
		if (!stored.token) return Promise.resolve();
		var after = lastId();
		return api("GET", "/messages" + (after ? "?after=" + encodeURIComponent(after) : ""))
			.then((r) => {
				state.conversation = r.conversation;
				var fresh = 0;
				for (var i = 0; i < r.messages.length; i++) {
					var m = r.messages[i];
					if (add(m, true) && m.author !== "visitor" && after) fresh++;
				}
				if (fresh && !state.open) {
					setUnread(state.unread + fresh);
					showNudge(r.messages[r.messages.length - 1]);
				}
				save({ last: Date.now() });
				render();
				setComposer();
			})
			.catch((e) => {
				if (e.status === 401) endChat();
			});
	}

	function endChat() {
		stored = save({
			token: null,
			conversation: null,
			emailJustSaved: false,
			emailDismissed: false,
		});
		state.conversation = null;
		state.messages = [];
		state.awayShown = false;
		disconnect();
		render();
		setComposer();
	}
	function newConversation() {
		endChat();
		input.focus();
	}

	/**
	 * Identity verification: the website says who is signed in. Their chat on this browser gets
	 * their details; someone else's is forgotten (another person signed in here); with none, their
	 * latest chat from any browser comes back.
	 */
	var identifying = null;
	function identifyNow() {
		if (!identity || cfg.preview) return Promise.resolve();
		var mine = identity;
		identifying = api("POST", "/identify", { identity: mine })
			.then((r) => {
				if (mine !== identity) return;
				if (r.status === "other_person") {
					endChat();
					return identifyNow();
				}
				if (r.status === "none") {
					if (stored.token) endChat();
					return;
				}
				if (r.token) stored = save({ token: r.token, last: Date.now() });
				state.conversation = r.conversation;
				merge(r.messages || []);
				save({ last: Date.now() });
				connect();
				renderCards();
				setComposer();
			})
			.catch(() => {})
			.then(() => {
				identifying = null;
			});
		return identifying;
	}

	// Typing: the team sees "typing…" (and the words, Intercom-style) as the visitor writes.
	var typingTimer = null;
	var lastTypingSent = 0;
	var typingTrail = null;
	function sendTyping() {
		typingTrail = null;
		if (!state.ws || state.ws.readyState !== 1) return;
		lastTypingSent = Date.now();
		state.ws.send(
			JSON.stringify({ type: "typing", on: true, text: input.value.slice(0, 500) }),
		);
	}
	// At most every 400 ms, the latest words always going last.
	function typing() {
		if (!state.ws || state.ws.readyState !== 1) return;
		var wait = 400 - (Date.now() - lastTypingSent);
		if (wait <= 0) sendTyping();
		else if (!typingTrail) typingTrail = setTimeout(sendTyping, wait);
		clearTimeout(typingTimer);
		typingTimer = setTimeout(stopTyping, 3500);
	}
	function stopTyping() {
		clearTimeout(typingTimer);
		clearTimeout(typingTrail);
		typingTrail = null;
		if (lastTypingSent && state.ws && state.ws.readyState === 1)
			state.ws.send(JSON.stringify({ type: "typing", on: false }));
		lastTypingSent = 0;
	}

	var seenTimer = null;
	function markSeen() {
		if (!state.open || document.hidden || !stored.token || cfg.preview) return;
		clearTimeout(seenTimer);
		seenTimer = setTimeout(() => {
			if (state.ws && state.ws.readyState === 1)
				state.ws.send(JSON.stringify({ type: "seen" }));
			else api("POST", "/seen", {}).catch(() => {});
		}, 800);
	}
	document.addEventListener("visibilitychange", () => {
		if (!document.hidden) {
			markSeen();
			if (stored.token && (state.open || recent())) {
				connect();
				refresh();
			}
		}
	});

	function recent() {
		return stored.last && Date.now() - stored.last < 2 * 86400000;
	}

	// ── Sending ────────────────────────────────────────────────────────────────

	var turnstileReady = null;
	function turnstileToken() {
		if (!cfg.turnstile) return Promise.resolve("");
		if (!turnstileReady)
			turnstileReady = new Promise((resolve, reject) => {
				if (window.turnstile) return resolve(window.turnstile);
				var s = document.createElement("script");
				s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
				s.async = true;
				s.onload = () => {
					var tries = 0;
					(function wait() {
						if (window.turnstile) resolve(window.turnstile);
						else if (tries++ > 50) reject(new Error("Couldn't load the robot check"));
						else setTimeout(wait, 100);
					})();
				};
				s.onerror = () => {
					turnstileReady = null;
					reject(new Error("Couldn't load the robot check"));
				};
				document.head.appendChild(s);
			});
		return turnstileReady.then(
			(ts) =>
				new Promise((resolve, reject) => {
					tsBox.textContent = "";
					// Turnstile draws into the page, not a shadow root: a box of its own beside ours.
					var holder = document.getElementById("mailroom-chat-ts-" + KEY);
					if (!holder) {
						holder = h("div", { id: "mailroom-chat-ts-" + KEY });
						holder.style.cssText =
							"position:fixed;z-index:2147483001;bottom:calc(" +
							((cfg.offset_y || 20) + 150) +
							"px);" +
							(cfg.position === "left" ? "left" : "right") +
							":" +
							((cfg.offset_x || 20) + 40) +
							"px";
						document.body.appendChild(holder);
					}
					holder.textContent = "";
					var done = false;
					var timer = setTimeout(() => {
						if (!done) reject(new Error("The robot check took too long; try again"));
					}, 30000);
					ts.render(holder, {
						sitekey: cfg.turnstile,
						appearance: "interaction-only",
						theme: dark ? "dark" : "light",
						callback: (t) => {
							done = true;
							clearTimeout(timer);
							holder.textContent = "";
							resolve(t);
						},
						"error-callback": () => {
							done = true;
							clearTimeout(timer);
							reject(new Error("We couldn't check you're not a robot; try again"));
						},
					});
				}),
		);
	}

	function send(text) {
		text = (text || "").trim();
		if (!text || state.sending) return;
		if (cfg.preview) return previewSend(text);
		var m = {
			id: "local-" + uuid(),
			client_id: uuid(),
			author: "visitor",
			text: text,
			files: [],
			at: new Date().toISOString(),
			pending: true,
		};
		add(m);
		deliver(m);
	}

	function deliver(m) {
		m.pending = true;
		m.failed = false;
		render();
		state.sending = !stored.token;
		setComposer();
		// A signed-in person's earlier chat may be coming back: write in it, not a new one.
		var p = (identifying || Promise.resolve()).then(() =>
			stored.token
				? api("POST", "/messages", { text: m.text, client_id: m.client_id })
				: (identity ? Promise.resolve("") : turnstileToken()).then((t) =>
						api("POST", "/start", {
							text: m.text,
							client_id: m.client_id,
							turnstile: t,
							email: stored.email || undefined,
							name: stored.name || undefined,
							identity: identity || undefined,
							page: location.href,
						}),
					),
		);
		p.then((r) => {
			state.sending = false;
			if (r.token) {
				stored = save({ token: r.token, last: Date.now() });
				state.conversation = r.conversation;
				merge(r.messages);
				connect();
				afterFirst();
			} else {
				add(r.message);
				save({ last: Date.now() });
			}
			setComposer();
		}).catch((e) => {
			state.sending = false;
			if (e.status === 401 && stored.token) {
				// The chat ended (deleted, expired): start a new one with this message.
				endChat();
				add(m);
				return deliver(m);
			}
			m.pending = false;
			m.failed = true;
			m.error = e.message;
			render();
			setComposer();
		});
	}
	function retry(m) {
		deliver(m);
	}

	/** After the first message: the away note when nobody's connected, then the email card. */
	function afterFirst() {
		setTimeout(() => {
			if (state.awayShown || !cfg.away || teamOnline) return;
			state.awayShown = true;
			var has = state.messages.some((x) => x.author !== "visitor");
			if (!has)
				add({
					id: "away",
					local: true,
					author: "system",
					text: cfg.away,
					files: [],
					at: new Date().toISOString(),
				});
		}, 1500);
	}

	function sendFile(file) {
		if (!file || cfg.preview) return;
		if (!stored.token) {
			add({
				id: "local-" + uuid(),
				local: true,
				author: "system",
				text: T("Write a message first, then send files."),
				files: [],
				at: new Date().toISOString(),
			});
			return;
		}
		if (file.size > 10 * 1024 * 1024) {
			add({
				id: "local-" + uuid(),
				local: true,
				author: "system",
				text: T("Files up to 10 MB, please."),
				files: [],
				at: new Date().toISOString(),
			});
			return;
		}
		var m = {
			id: "local-" + uuid(),
			client_id: uuid(),
			author: "visitor",
			text: "",
			files: [{ id: "f", filename: file.name, size: file.size, image: false }],
			at: new Date().toISOString(),
			pending: true,
		};
		add(m);
		var fd = new FormData();
		fd.append("file", file);
		fd.append("client_id", m.client_id);
		api("POST", "/files", fd, true)
			.then((r) => {
				add(r.message);
			})
			.catch((e) => {
				m.pending = false;
				m.failed = true;
				m.error = e.message;
				m.retryFile = file;
				render();
			});
	}

	form.addEventListener("submit", (e) => {
		e.preventDefault();
		var t = input.value;
		if (!t.trim() || needEmail()) return;
		input.value = "";
		grow();
		stopTyping();
		send(t);
		setComposer();
	});
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
			e.preventDefault();
			form.requestSubmit
				? form.requestSubmit()
				: form.dispatchEvent(new Event("submit", { cancelable: true }));
		}
	});
	function grow() {
		input.style.height = "auto";
		input.style.height = Math.min(input.scrollHeight, 132) + "px";
	}
	input.addEventListener("input", () => {
		grow();
		setComposer();
		if (input.value.trim()) typing();
		else stopTyping();
	});
	input.addEventListener("paste", (e) => {
		var items = (e.clipboardData && e.clipboardData.files) || [];
		if (items.length && state.conversation) {
			e.preventDefault();
			for (var i = 0; i < items.length; i++) sendFile(items[i]);
		}
	});
	fileInput.addEventListener("change", () => {
		for (var i = 0; i < fileInput.files.length; i++) sendFile(fileInput.files[i]);
		fileInput.value = "";
	});
	var dragDepth = 0;
	panel.addEventListener("dragenter", (e) => {
		if (
			!state.conversation ||
			!e.dataTransfer ||
			[].indexOf.call(e.dataTransfer.types, "Files") < 0
		)
			return;
		dragDepth++;
		drop.classList.add("on");
	});
	panel.addEventListener("dragleave", () => {
		dragDepth = Math.max(0, dragDepth - 1);
		if (!dragDepth) drop.classList.remove("on");
	});
	panel.addEventListener("dragover", (e) => {
		if (state.conversation) e.preventDefault();
	});
	panel.addEventListener("drop", (e) => {
		e.preventDefault();
		dragDepth = 0;
		drop.classList.remove("on");
		var files = (e.dataTransfer && e.dataTransfer.files) || [];
		for (var i = 0; i < files.length; i++) sendFile(files[i]);
	});

	// ── Live ───────────────────────────────────────────────────────────────────

	var teamOnline = false;
	var pingTimer = null;
	var retryTimer = null;

	function connect() {
		if (cfg.preview || !stored.token || !window.WebSocket) return startPolling();
		if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;
		clearTimeout(retryTimer);
		var url =
			cfg.api.replace(/^http/, "ws") + "/live?token=" + encodeURIComponent(stored.token);
		var ws;
		try {
			ws = new WebSocket(url);
		} catch (_) {
			return startPolling();
		}
		state.ws = ws;
		ws.onopen = () => {
			var reconnected = state.wsTries > 0;
			state.wsTries = 0;
			setBanner("");
			stopPolling();
			clearInterval(pingTimer);
			pingTimer = setInterval(() => {
				if (ws.readyState === 1) ws.send('{"type":"ping"}');
			}, 25000);
			if (reconnected) refresh();
			markSeen();
		};
		ws.onmessage = (e) => {
			var ev;
			try {
				ev = JSON.parse(e.data);
			} catch (_) {
				return;
			}
			if (ev.type === "message" && ev.message) {
				var m = ev.message;
				var isNew = add(m);
				if (m.author !== "visitor") {
					state.typing = null;
					renderTyping();
					if (isNew) {
						if (state.open && !document.hidden) markSeen();
						else {
							setUnread(state.unread + 1);
							showNudge(m);
						}
					}
				}
				save({ last: Date.now() });
			} else if (ev.type === "typing" && ev.role === "team") {
				state.typing = ev.on ? { name: ev.name } : null;
				renderTyping();
				if (ev.on) scrollDown();
				clearTimeout(state.typingTimer);
				if (ev.on)
					state.typingTimer = setTimeout(() => {
						state.typing = null;
						renderTyping();
					}, 8000);
			} else if (ev.type === "hello") {
				teamOnline = !!ev.team_online;
			} else if (ev.type === "conversation") {
				if (state.conversation) state.conversation.status = ev.status;
			} else if (ev.type === "visitor" && state.conversation) {
				state.conversation.visitor = ev.visitor;
				renderCards();
			} else if (ev.type === "deleted") {
				endChat();
			}
		};
		ws.onclose = (e) => {
			clearInterval(pingTimer);
			if (state.ws === ws) state.ws = null;
			if (e.code === 4000 || !stored.token) return;
			state.wsTries++;
			if (state.wsTries >= 4) startPolling();
			if (state.open && state.wsTries > 1) setBanner("Reconnecting…");
			var wait = Math.min(30000, 1000 * 2 ** (state.wsTries - 1));
			if (!document.hidden) retryTimer = setTimeout(connect, wait);
		};
	}
	function disconnect() {
		clearTimeout(retryTimer);
		clearInterval(pingTimer);
		stopPolling();
		if (state.ws) {
			var ws = state.ws;
			state.ws = null;
			try {
				ws.close(1000);
			} catch (_) {}
		}
	}
	function startPolling() {
		if (state.poll || cfg.preview || !stored.token) return;
		state.poll = setInterval(() => {
			if (document.hidden) return;
			if (!state.open && Math.random() < 0.75) return;
			refresh();
		}, 4000);
	}
	function stopPolling() {
		clearInterval(state.poll);
		state.poll = null;
	}
	window.addEventListener("online", () => {
		setBanner("");
		if (stored.token) connect();
	});
	window.addEventListener("offline", () => {
		if (state.open) setBanner("You're offline");
	});

	// ── Preview (the dashboard's settings page) ────────────────────────────────

	var previewReplyTimer = null;
	function previewSend(text) {
		add({
			id: "p" + uuid(),
			author: "visitor",
			text: text,
			files: [],
			at: new Date().toISOString(),
		});
		clearTimeout(previewReplyTimer);
		state.typing = { name: "Alex" };
		renderTyping();
		scrollDown();
		previewReplyTimer = setTimeout(() => {
			state.typing = null;
			add({
				id: "p" + uuid(),
				author: "team",
				name: "Alex",
				text: "This is a preview: on your site, your team answers here.",
				files: [],
				at: new Date().toISOString(),
			});
		}, 1400);
	}
	function applyDesign(next) {
		for (var k in next) cfg[k] = next[k];
		LANG = cfg.language === "es" ? "es" : "en";
		dark =
			cfg.theme === "dark" ||
			(cfg.theme !== "light" &&
				window.matchMedia &&
				matchMedia("(prefers-color-scheme: dark)").matches);
		root.className = "root" + (dark ? " dark" : "") + (state.open ? " open" : "");
		style.textContent = css(cfg);
		head.querySelector(".ht b").textContent = cfg.title;
		var small = head.querySelector(".ht small span:last-child");
		if (small) small.textContent = cfg.subtitle || "";
		var hs = head.querySelector(".ht small");
		if (hs) hs.style.display = cfg.subtitle ? "" : "none";
		var lg = head.querySelector(".logo");
		if (lg) lg.replaceWith(logoEl("logo"));
		input.placeholder = cfg.placeholder || T("Write a message…");
		launcher.className = "launcher" + (cfg.launcher === "label" ? " label" : "");
		launcher.querySelector(".ic").innerHTML = launcherIcon();
		var lt = launcher.querySelector(".lt");
		if (cfg.launcher === "label") {
			if (!lt)
				launcher.insertBefore(
					h("span", { class: "lt", text: cfg.launcher_text || "Chat" }),
					badge,
				);
			else lt.textContent = cfg.launcher_text || "Chat";
		} else if (lt) lt.remove();
		note.textContent = cfg.retention
			? T("Chats are deleted {x} after the last message.").replace(
					"{x}",
					retentionText(cfg.retention),
				)
			: "";
		render();
	}
	if (cfg.preview) {
		state.messages = [
			{
				id: "p1",
				author: "visitor",
				text: "Hi! Do you have rooms for this weekend?",
				files: [],
				at: new Date(Date.now() - 4 * 60000).toISOString(),
			},
			{
				id: "p2",
				author: "team",
				name: "Alex",
				text: "Hi! Yes, we do. For how many people?",
				files: [],
				at: new Date(Date.now() - 3 * 60000).toISOString(),
			},
		];
		window.addEventListener("message", (e) => {
			if (!e.data) return;
			if (e.data.type === "mailroom-chat-design") applyDesign(e.data.config || {});
			// What the preview shows: the chat open, closed, or the greeting popped up.
			if (e.data.type === "mailroom-chat-view") {
				nudge.classList.remove("on");
				if (e.data.view === "open") openPanel();
				else {
					closePanel();
					if (e.data.view === "nudge") {
						cfg.preview = false;
						showNudge({ name: null, text: cfg.greeting || "Hi! How can we help?" });
						cfg.preview = true;
					}
				}
			}
		});
	}

	// ── Start ──────────────────────────────────────────────────────────────────

	function mount() {
		if (!document.body) return setTimeout(mount, 50);
		document.body.appendChild(host);
		render();
		setComposer();
		if (cfg.preview) {
			openPanel();
			return;
		}
		if (identity) identifyNow();
		else if (stored.token && recent()) {
			refresh();
			connect();
		}
		if (location.hash === "#mailroom-chat") openPanel();
		else greetLater();
	}
	/** The greeting pops up by the launcher after a while (once a visit, never mid-chat). */
	function greetLater() {
		var s = Number(cfg.nudge_after) || 0;
		if (s <= 0 || stored.token || !cfg.greeting) return;
		try {
			if (sessionStorage.getItem(STORE + ":greeted")) return;
		} catch (_) {}
		setTimeout(() => {
			if (state.open || stored.token) return;
			try {
				sessionStorage.setItem(STORE + ":greeted", "1");
			} catch (_) {}
			showNudge({ name: null, text: cfg.greeting });
		}, s * 1000);
	}
	mount();

	window.MailroomChat = {
		open: openPanel,
		close: closePanel,
		toggle: toggle,
		/** Who the visitor is: { token } signed by the website's server (verified), or
		 * { email, name } (unverified), so they're not asked. */
		identify: (who) => {
			who = who || {};
			if (typeof who.token === "string") {
				var changed = who.token !== identity;
				identity = who.token;
				if (changed) identifyNow();
				return;
			}
			var patch = {};
			if (who.email) patch.email = String(who.email).trim();
			if (who.name) patch.name = String(who.name).trim();
			stored = save(patch);
			if (stored.token) api("POST", "/profile", patch).catch(() => {});
			renderCards();
			setComposer();
		},
		/** The person signed out: forget their chat on this browser (it stays theirs). */
		reset: () => {
			identity = null;
			closePanel();
			endChat();
			stored = save({ email: null, name: null });
			setUnread(0);
		},
		unread: () => state.unread,
	};
	emit("ready");
}
