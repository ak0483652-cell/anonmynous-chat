// Traffic analytics API. server.js mein: const analytics = createAnalyticsApi(); ... if (await analytics(request, response, pathname)) return;
//
// POST /api/track       public, ek visit save (client har session mein ek baar bhejta hai)
// GET  /api/analytics   header x-analytics-key: <ANALYTICS_KEY>  ?days=7
//
// Env: ANALYTICS_KEY (koi lamba secret), SUPABASE_URL, SUPABASE_SERVICE_KEY (pehle se hain)

import { timingSafeEqual } from "node:crypto";

const BASE = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const KEY = (process.env.SUPABASE_SERVICE_KEY || "").trim();
const ADMIN_KEY = (process.env.ANALYTICS_KEY || "").trim();
const ADMIN_EMAILS = new Set((process.env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));
const OWN_HOSTS = (process.env.SITE_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);

const SOURCES = [
	[/(^|\.)google\./, "google"], [/(^|\.)bing\.com$/, "bing"], [/duckduckgo\.com$/, "duckduckgo"],
	[/instagram\.com$/, "instagram"], [/(^|\.)facebook\.com$|^fb\.com$|^lm\.facebook/, "facebook"],
	[/^t\.co$|twitter\.com$|(^|\.)x\.com$/, "twitter/x"], [/youtube\.com$|^youtu\.be$/, "youtube"],
	[/whatsapp\.com$|^wa\.me$/, "whatsapp"], [/telegram|^t\.me$/, "telegram"], [/reddit\.com$/, "reddit"],
	[/linkedin\.com$|^lnkd\.in$/, "linkedin"]
];

const hits = new Map();
function limited(ip) {
	const now = Date.now();
	const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
	if (list.length >= 20) return true;
	list.push(now);
	hits.set(ip, list);
	return false;
}
setInterval(() => hits.clear(), 3600_000).unref();

function send(response, status, data) {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"access-control-allow-origin": "*",
		"access-control-allow-headers": "authorization, content-type, x-analytics-key",
		"access-control-allow-methods": "GET, POST, OPTIONS",
		"cache-control": "no-store"
	});
	response.end(JSON.stringify(data));
}

async function readJson(request) {
	let size = 0;
	const chunks = [];
	for await (const chunk of request) {
		size += chunk.length;
		if (size > 2048) throw Object.assign(new Error("too large"), { status: 413 });
		chunks.push(chunk);
	}
	try {
		return size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
	} catch {
		throw Object.assign(new Error("bad json"), { status: 400 });
	}
}

async function supabase(path, options = {}) {
	const response = await fetch(`${BASE}${path}`, {
		...options,
		headers: { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json" },
		signal: AbortSignal.timeout(10000)
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`Supabase ${response.status}: ${text.slice(0, 200)}`);
	return text ? JSON.parse(text) : null;
}

const clean = (value, max) => String(value || "").trim().toLowerCase().slice(0, max);

function hostOf(ref) {
	try {
		return new URL(ref).hostname.replace(/^www\./, "").toLowerCase();
	} catch {
		return "";
	}
}

function classify(utm, refHost) {
	const utmSource = clean(utm?.source, 40);
	if (utmSource) return { source: utmSource, medium: clean(utm?.medium, 40) || "campaign" };
	if (!refHost || OWN_HOSTS.includes(refHost)) return { source: "direct", medium: "none" };
	for (const [pattern, name] of SOURCES) if (pattern.test(refHost)) return { source: name, medium: "referral" };
	return { source: refHost, medium: "referral" };
}

function deviceOf(ua = "") {
	if (/bot|crawl|spider|preview|facebookexternalhit|whatsapp/i.test(ua)) return "bot";
	if (/ipad|tablet/i.test(ua)) return "tablet";
	if (/mobi|android|iphone/i.test(ua)) return "mobile";
	return "desktop";
}

function safeEqual(a, b) {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

export function createAnalyticsApi({ verifyToken } = {}) {
	async function isAdmin(request) {
		const given = String(request.headers["x-analytics-key"] || "");
		if (ADMIN_KEY && given && safeEqual(given, ADMIN_KEY)) return true;
		const header = request.headers.authorization || "";
		if (!verifyToken || !header.startsWith("Bearer ")) return false;
		const account = await verifyToken(header.slice(7).trim());
		return Boolean(account?.email && ADMIN_EMAILS.has(account.email.toLowerCase()));
	}

	return async function handle(request, response, pathname) {
		if (pathname !== "/api/track" && pathname !== "/api/analytics") return false;
		if (request.method === "OPTIONS") return send(response, 204, {}), true;
		try {
			if (!BASE || !KEY) return send(response, 503, { error: "not_configured" }), true;

			if (pathname === "/api/track" && request.method === "POST") {
				const ip = String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "").split(",")[0].trim();
				if (limited(ip)) return send(response, 429, { error: "slow_down" }), true;
				const body = await readJson(request);
				const device = deviceOf(request.headers["user-agent"]);
				if (device === "bot") return send(response, 200, { ok: true }), true;
				const vid = clean(body.vid, 64);
				if (!vid) return send(response, 400, { error: "no_vid" }), true;
				const refHost = hostOf(body.ref);
				const { source, medium } = classify(body.utm, refHost);
				const country = clean(request.headers["cf-ipcountry"] || request.headers["x-vercel-ip-country"], 2).toUpperCase() || null;
				await supabase("/rest/v1/traffic_hits", {
					method: "POST",
					body: JSON.stringify({
						vid, source, medium, device, country,
						path: String(body.path || "/").slice(0, 200),
						campaign: clean(body.utm?.campaign, 60) || null,
						referrer_host: refHost || null
					})
				});
				return send(response, 201, { ok: true }), true;
			}

			if (pathname === "/api/analytics" && request.method === "GET") {
				if (!(await isAdmin(request))) return send(response, 403, { error: "forbidden" }), true;
				const days = Math.min(Math.max(Number(new URL(request.url, "http://x").searchParams.get("days")) || 7, 1), 90);
				const data = await supabase("/rest/v1/rpc/traffic_summary", { method: "POST", body: JSON.stringify({ p_days: days }) });
				return send(response, 200, data), true;
			}
			return send(response, 405, { error: "method_not_allowed" }), true;
		} catch (error) {
			if (error.status) return send(response, error.status, { error: error.message }), true;
			console.error("Analytics error:", error.message);
			return send(response, 500, { error: "server_error" }), true;
		}
	};
}
