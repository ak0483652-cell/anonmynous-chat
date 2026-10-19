// Cloudflare R2 ke liye presigned upload URL (AWS SigV4). Koi npm package nahi chahiye.
// Render Environment: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL
// Secret keys kabhi GitHub/browser mein mat daalna.

import { createHash, createHmac, randomBytes } from "node:crypto";

const ACCOUNT_ID = (process.env.R2_ACCOUNT_ID || "").trim();
const ACCESS_KEY_ID = (process.env.R2_ACCESS_KEY_ID || "").trim();
const SECRET_ACCESS_KEY = (process.env.R2_SECRET_ACCESS_KEY || "").trim();
const BUCKET = (process.env.R2_BUCKET || "").trim();
export const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || "").trim().replace(/\/+$/, "");

export const r2Enabled = Boolean(ACCOUNT_ID && ACCESS_KEY_ID && SECRET_ACCESS_KEY && BUCKET && R2_PUBLIC_URL);

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// Generic SigV4 presign (testable: AWS ke official example se match karta hai).
export function presignUrl({ method, host, path, region, accessKeyId, secretAccessKey, expires, now = new Date() }) {
	const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
	const date = amzDate.slice(0, 8);
	const scope = `${date}/${region}/s3/aws4_request`;
	const query = {
		"X-Amz-Algorithm": "AWS4-HMAC-SHA256",
		"X-Amz-Credential": `${accessKeyId}/${scope}`,
		"X-Amz-Date": amzDate,
		"X-Amz-Expires": String(expires),
		"X-Amz-SignedHeaders": "host"
	};
	const canonicalQuery = Object.keys(query).sort().map((k) => `${encode(k)}=${encode(query[k])}`).join("&");
	const canonicalRequest = [method, path, canonicalQuery, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
	const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
	const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), "s3"), "aws4_request");
	const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
	return `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

const TYPES = {
	video: { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" },
	poster: { "image/jpeg": "jpg", "image/webp": "webp", "image/png": "png" }
};

// kind: "video" | "poster". Galat contentType par null.
export function createUpload(kind, contentType) {
	const ext = TYPES[kind]?.[contentType];
	if (!r2Enabled || !ext) return null;
	const key = `reels/${Date.now()}-${randomBytes(6).toString("hex")}.${ext}`;
	const host = `${ACCOUNT_ID}.r2.cloudflarestorage.com`;
	const path = `/${BUCKET}/${key.split("/").map(encode).join("/")}`;
	const uploadUrl = presignUrl({ method: "PUT", host, path, region: "auto", accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY, expires: 900 });
	return { uploadUrl, publicUrl: `${R2_PUBLIC_URL}/${key}`, key };
}

// Sirf apne bucket ki reels/ files hi database mein jaa sakti hain.
export function isOwnMediaUrl(url) {
	return typeof url === "string" && r2Enabled && url.startsWith(`${R2_PUBLIC_URL}/reels/`) && url.length < 500 && !/[\s"'<>]/.test(url);
}
