// Reels ke saare HTTP APIs. server.js sirf createReelsApi() ko call karta hai.
//
// GET    /api/reels                  feed (sab dekh sakte hain; Authorization de to "liked" bhi aata hai)
// GET    /api/reels/me               {signedIn, admin}
// GET    /api/reels/:id              ek reel (share link ke liye)
// POST   /api/reels/presign          [admin] R2 upload URL
// POST   /api/reels                  [admin] reel save
// DELETE /api/reels/:id              [admin] reel delete
// POST   /api/reels/:id/like         [login] body {liked:true|false}
// GET    /api/reels/:id/comments     comments
// POST   /api/reels/:id/comments     [login] body {text}
// DELETE /api/comments/:id           [login] apna comment (admin kisi ka bhi)
// POST   /api/comments/:id/report    [login]
// "Login" = Firebase Gmail sign-in (wahi jo chat mein hai). Anonymous users sirf dekh sakte hain.

import { createHash } from "node:crypto";
import { createUpload, isOwnMediaUrl, r2Enabled } from "./r2.js";
import * as store from "./reels-store.js";

const ADMIN_EMAILS = new Set((process.env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));
const REPORT_HIDE_THRESHOLD = Number(process.env.REEL_REPORT_THRESHOLD) > 0 ? Number(process.env.REEL_REPORT_THRESHOLD) : 3;
const PAGE_SIZE = 8;
const COMMENT_PAGE = 30;
const MAX_BODY = 4096;

const limits = new Map(); // "action:uid" -> [timestamps]
function limited(action, uid, max, windowMs) {
	const key = `${action}:${uid}`;
	const now = Date.now();
	const hits = (limits.get(key) || []).filter((t) => now - t < windowMs);
	if (hits.length >= max) {
		limits.set(key, hits);
		return true;
	}
	hits.push(now);
	limits.set(key, hits);
	return false;
}
setInterval(() => {
	const now = Date.now();
	for (const [key, hits] of limits) if (hits.every((t) => now - t > 3600_000)) limits.delete(key);
}, 10 * 60 * 1000).unref();

function send(response, status, data) {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"access-control-allow-origin": "*",
		"access-control-allow-headers": "authorization, content-type",
		"access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
		"access-control-max-age": "86400",
		"cache-control": "no-store"
	});
	response.end(JSON.stringify(data));
}

async function readJson(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > MAX_BODY) throw Object.assign(new Error("too large"), { status: 413 });
		chunks.push(chunk);
	}
	if (size === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw Object.assign(new Error("bad json"), { status: 400 });
	}
}

const displayName = (uid) => `User-${createHash("sha256").update(uid).digest("hex").slice(0, 4).toUpperCase()}`;

function reelOut(row, liked) {
	return {
		id: row.id,
		videoUrl: row.video_url,
		posterUrl: row.poster_url || "",
		caption: row.caption || "",
		likes: row.like_count,
		comments: row.comment_count,
		liked: liked.has(row.id),
		createdAt: row.created_at
	};
}

export function createReelsApi({ verifyToken }) {
	async function getUser(request) {
		const header = request.headers.authorization || "";
		if (!header.startsWith("Bearer ")) return null;
		const account = await verifyToken(header.slice(7).trim());
		if (!account) return null;
		return { uid: account.uid, email: account.email || "", admin: Boolean(account.email && ADMIN_EMAILS.has(account.email)) };
	}

	// true = request handle ho gayi, false = ye reels ka route nahi hai
	return async function handle(request, response, pathname) {
		const isReels = pathname === "/api/reels" || pathname.startsWith("/api/reels/");
		const isComments = pathname.startsWith("/api/comments/");
		if (!isReels && !isComments) return false;

		if (request.method === "OPTIONS") {
			send(response, 204, {});
			return true;
		}

		try {
			if (!store.reelsStoreEnabled) {
				send(response, 503, { error: "reels_not_configured" });
				return true;
			}
			const parts = pathname.split("/").filter(Boolean); // ["api","reels",...]
			const method = request.method;
			const user = await getUser(request);
			const url = new URL(request.url, "http://localhost");

			if (isComments) {
				const id = parts[2];
				if (!store.isUuid(id)) return send(response, 400, { error: "bad_id" }), true;
				if (!user) return send(response, 401, { error: "login_required" }), true;
				if (parts.length === 3 && method === "DELETE") {
					const comment = await store.getComment(id);
					if (!comment) return send(response, 404, { error: "not_found" }), true;
					if (comment.uid !== user.uid && !user.admin) return send(response, 403, { error: "forbidden" }), true;
					await store.deleteComment(id);
					return send(response, 200, { ok: true }), true;
				}
				if (parts.length === 4 && parts[3] === "report" && method === "POST") {
					if (limited("report", user.uid, 20, 3600_000)) return send(response, 429, { error: "slow_down" }), true;
					const comment = await store.getComment(id);
					if (!comment) return send(response, 404, { error: "not_found" }), true;
					await store.reportComment(id, user.uid, REPORT_HIDE_THRESHOLD);
					return send(response, 200, { ok: true }), true;
				}
				return send(response, 404, { error: "not_found" }), true;
			}

			// /api/reels
			if (parts.length === 2) {
				if (method === "GET") {
					const before = url.searchParams.get("before") || "";
					if (before && before.length > 40) return send(response, 400, { error: "bad_cursor" }), true;
					const rows = await store.listReels({ limit: PAGE_SIZE + 1, before });
					const page = rows.slice(0, PAGE_SIZE);
					const liked = user ? await store.likedReelIds(user.uid, page.map((r) => r.id)) : new Set();
					return send(response, 200, { reels: page.map((r) => reelOut(r, liked)), next: rows.length > PAGE_SIZE ? page[page.length - 1].created_at : null }), true;
				}
				if (method === "POST") {
					if (!user?.admin) return send(response, 403, { error: "admin_only" }), true;
					const body = await readJson(request);
					const caption = String(body.caption || "").trim().slice(0, 300);
					if (!isOwnMediaUrl(body.videoUrl) || (body.posterUrl && !isOwnMediaUrl(body.posterUrl))) return send(response, 400, { error: "bad_media_url" }), true;
					const row = await store.createReel({ videoUrl: body.videoUrl, posterUrl: body.posterUrl || null, caption });
					return send(response, 201, { reel: reelOut(row, new Set()) }), true;
				}
				return send(response, 405, { error: "method_not_allowed" }), true;
			}

			if (parts[2] === "me" && parts.length === 3 && method === "GET") {
				return send(response, 200, { signedIn: Boolean(user), admin: Boolean(user?.admin), uploads: r2Enabled }), true;
			}

			if (parts[2] === "presign" && parts.length === 3 && method === "POST") {
				if (!user?.admin) return send(response, 403, { error: "admin_only" }), true;
				const body = await readJson(request);
				const upload = createUpload(body.kind === "poster" ? "poster" : "video", String(body.contentType || ""));
				if (!upload) return send(response, 400, { error: r2Enabled ? "bad_content_type" : "r2_not_configured" }), true;
				return send(response, 200, upload), true;
			}

			const reelId = parts[2];
			if (!store.isUuid(reelId)) return send(response, 400, { error: "bad_id" }), true;

			if (parts.length === 3) {
				if (method === "GET") {
					const row = await store.getReel(reelId);
					if (!row) return send(response, 404, { error: "not_found" }), true;
					const liked = user ? await store.likedReelIds(user.uid, [reelId]) : new Set();
					return send(response, 200, { reel: reelOut(row, liked) }), true;
				}
				if (method === "DELETE") {
					if (!user?.admin) return send(response, 403, { error: "admin_only" }), true;
					await store.deleteReel(reelId);
					return send(response, 200, { ok: true }), true;
				}
			}

			if (parts.length === 4 && parts[3] === "like" && method === "POST") {
				if (!user) return send(response, 401, { error: "login_required" }), true;
				if (limited("like", user.uid, 60, 60_000)) return send(response, 429, { error: "slow_down" }), true;
				const body = await readJson(request);
				const likes = body.liked === false ? await store.unlikeReel(reelId, user.uid) : await store.likeReel(reelId, user.uid);
				return send(response, 200, { likes, liked: body.liked !== false }), true;
			}

			if (parts.length === 4 && parts[3] === "comments") {
				if (method === "GET") {
					const before = url.searchParams.get("before") || "";
					if (before && before.length > 40) return send(response, 400, { error: "bad_cursor" }), true;
					const rows = await store.listComments(reelId, { limit: COMMENT_PAGE + 1, before });
					const page = rows.slice(0, COMMENT_PAGE);
					return send(response, 200, {
						comments: page.map((c) => ({ id: c.id, author: c.author, text: c.body, createdAt: c.created_at, mine: Boolean(user && c.uid === user.uid) })),
						next: rows.length > COMMENT_PAGE ? page[page.length - 1].created_at : null
					}), true;
				}
				if (method === "POST") {
					if (!user) return send(response, 401, { error: "login_required" }), true;
					const body = await readJson(request);
					const text = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, 300);
					if (!text) return send(response, 400, { error: "empty" }), true;
					if (limited("comment", user.uid, 1, 3000) || limited("comment-hour", user.uid, 30, 3600_000)) return send(response, 429, { error: "slow_down" }), true;
					const row = await store.addComment(reelId, user.uid, user.admin ? "Team" : displayName(user.uid), text);
					return send(response, 201, { comment: { id: row.id, author: row.author, text: row.body, createdAt: row.created_at, mine: true } }), true;
				}
			}

			return send(response, 404, { error: "not_found" }), true;
		} catch (error) {
			if (error.status) return send(response, error.status, { error: error.message }), true;
			console.error("Reels API error:", error.message);
			return send(response, 500, { error: "server_error" }), true;
		}
	};
}
