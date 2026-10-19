// Reels ka database layer: Supabase REST (naya npm package nahi chahiye, sirf fetch).
// Wahi Render Environment variables jo wallet use karta hai: SUPABASE_URL, SUPABASE_SERVICE_KEY.
// SUPABASE_SERVICE_KEY (service_role) kabhi browser/GitHub mein mat daalna.

const BASE = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const KEY = (process.env.SUPABASE_SERVICE_KEY || "").trim();

export const reelsStoreEnabled = Boolean(BASE && KEY);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value) => typeof value === "string" && UUID.test(value);

async function call(path, { method = "GET", body, prefer } = {}) {
	const response = await fetch(`${BASE}${path}`, {
		method,
		headers: {
			apikey: KEY,
			authorization: `Bearer ${KEY}`,
			"content-type": "application/json",
			...(prefer ? { prefer } : {})
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(10000)
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`Supabase ${response.status}: ${text.slice(0, 300)}`);
	return text ? JSON.parse(text) : null;
}

const rpc = (name, args) => call(`/rest/v1/rpc/${name}`, { method: "POST", body: args });

export async function listReels({ limit, before }) {
	let path = `/rest/v1/reels?select=*&order=created_at.desc&limit=${Number(limit)}`;
	if (before) path += `&created_at=lt.${encodeURIComponent(before)}`;
	return call(path);
}

export async function getReel(id) {
	const rows = await call(`/rest/v1/reels?select=*&id=eq.${id}&limit=1`);
	return rows[0] || null;
}

export async function createReel({ videoUrl, posterUrl, caption }) {
	const rows = await call("/rest/v1/reels", {
		method: "POST",
		prefer: "return=representation",
		body: { video_url: videoUrl, poster_url: posterUrl || null, caption }
	});
	return rows[0];
}

export const deleteReel = (id) => call(`/rest/v1/reels?id=eq.${id}`, { method: "DELETE" });

// Is uid ne in reels mein se kin ko like kiya hai
export async function likedReelIds(uid, reelIds) {
	if (!uid || reelIds.length === 0) return new Set();
	const rows = await call(`/rest/v1/reel_likes?select=reel_id&uid=eq.${encodeURIComponent(uid)}&reel_id=in.(${reelIds.join(",")})`);
	return new Set(rows.map((row) => row.reel_id));
}

export const likeReel = (reelId, uid) => rpc("reel_like", { p_reel: reelId, p_uid: uid });
export const unlikeReel = (reelId, uid) => rpc("reel_unlike", { p_reel: reelId, p_uid: uid });

export async function listComments(reelId, { limit, before }) {
	let path = `/rest/v1/reel_comments?select=id,uid,author,body,created_at&reel_id=eq.${reelId}&hidden=eq.false&order=created_at.desc&limit=${Number(limit)}`;
	if (before) path += `&created_at=lt.${encodeURIComponent(before)}`;
	return call(path);
}

export async function getComment(id) {
	const rows = await call(`/rest/v1/reel_comments?select=id,uid,reel_id&id=eq.${id}&limit=1`);
	return rows[0] || null;
}

export const addComment = (reelId, uid, author, body) => rpc("reel_comment_add", { p_reel: reelId, p_uid: uid, p_author: author, p_body: body });
export const deleteComment = (id) => rpc("reel_comment_delete", { p_comment: id });
export const reportComment = (id, uid, threshold) => rpc("reel_comment_report", { p_comment: id, p_uid: uid, p_threshold: threshold });
