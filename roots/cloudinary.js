// Cloudinary (free plan, card nahi chahiye) se video upload + delivery. Koi npm package nahi chahiye.
// Render Environment: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
// API secret kabhi GitHub/browser mein mat daalna.

import { createHash, randomBytes } from "node:crypto";

const CLOUD = (process.env.CLOUDINARY_CLOUD_NAME || "").trim();
const API_KEY = (process.env.CLOUDINARY_API_KEY || "").trim();
const API_SECRET = (process.env.CLOUDINARY_API_SECRET || "").trim();

export const cloudEnabled = Boolean(CLOUD && API_KEY && API_SECRET);

// Phone ke liye halka: width 720 tak, H.264 MP4, quality auto.
const VIDEO_TRANSFORM = "q_auto,w_720,c_limit,vc_h264";
// Thumbnail: video ke 1 second ka frame.
const POSTER_TRANSFORM = "so_1,w_540,c_limit,q_auto,f_jpg";

const sha1 = (text) => createHash("sha1").update(text).digest("hex");

// Cloudinary signature: params ko naam se sort karo, "k=v&k=v" banao, secret jodo, SHA-1.
export function signParams(params, secret = API_SECRET) {
	const text = Object.keys(params)
		.filter((key) => params[key] !== undefined && params[key] !== "")
		.sort()
		.map((key) => `${key}=${params[key]}`)
		.join("&");
	return sha1(text + secret);
}

export const isPublicId = (value) => typeof value === "string" && /^reels\/[a-f0-9]{16}$/.test(value);
export const videoUrl = (publicId) => `https://res.cloudinary.com/${CLOUD}/video/upload/${VIDEO_TRANSFORM}/${publicId}.mp4`;
export const posterUrl = (publicId) => `https://res.cloudinary.com/${CLOUD}/video/upload/${POSTER_TRANSFORM}/${publicId}.jpg`;

// Admin ke browser ko signed upload ka saara data. Secret kabhi bahar nahi jaata, sirf signature jaata hai.
export function createUpload() {
	if (!cloudEnabled) return null;
	const publicId = `reels/${randomBytes(8).toString("hex")}`;
	const params = { allowed_formats: "mp4,webm,mov", public_id: publicId, timestamp: Math.floor(Date.now() / 1000) };
	return {
		uploadUrl: `https://api.cloudinary.com/v1_1/${CLOUD}/video/upload`,
		fields: { ...params, api_key: API_KEY, signature: signParams(params) },
		publicId,
		videoUrl: videoUrl(publicId),
		posterUrl: posterUrl(publicId)
	};
}

// Reel delete hone par Cloudinary se bhi video hata do (storage bachane ke liye). Fail ho to koi baat nahi.
export function publicIdFromUrl(url) {
	const match = /\/(reels\/[a-f0-9]{16})\.(?:mp4|jpg)$/.exec(String(url || ""));
	return match ? match[1] : null;
}

export async function deleteAsset(publicId) {
	if (!cloudEnabled || !isPublicId(publicId)) return;
	const params = { invalidate: "true", public_id: publicId, timestamp: Math.floor(Date.now() / 1000) };
	const form = new URLSearchParams({ ...params, api_key: API_KEY, signature: signParams(params) });
	try {
		await fetch(`https://api.cloudinary.com/v1_1/${CLOUD}/video/destroy`, { method: "POST", body: form, signal: AbortSignal.timeout(10000) });
	} catch (error) {
		console.error("Cloudinary delete failed:", error.message);
	}
}
