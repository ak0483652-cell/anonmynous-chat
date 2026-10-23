// Strangely Wallet (credits) backend. server.js sirf createWallet() ko call karta hai.
// Wahi Supabase variables jo reels use karte hain: SUPABASE_URL, SUPABASE_SERVICE_KEY.
// Credits sirf Gmail (Firebase) se sign-in kiye hue users ko milte hain (socket.uid).
//
// Optional Render Environment variables (sab ke default neeche hain):
//   WALLET_REEL_CREDITS, WALLET_LONG_REEL_CREDITS, WALLET_LONG_REEL_SEC,
//   WALLET_REFERRER_CREDITS, WALLET_NEW_USER_CREDITS,
//   WALLET_REEL_DAILY_MAX (ek user ke din bhar mein max reel rewards),
//   WALLET_CHAT_CHARGE=1 (tabhi "Chat with a woman" par credits katenge; default band),
//   WALLET_CHAT_CREDITS, WALLET_CHAT_AFTER_MESSAGES

import { getReel, isUuid, reelsStoreEnabled } from "./reels-store.js";

const BASE = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const KEY = (process.env.SUPABASE_SERVICE_KEY || "").trim();
export const walletEnabled = Boolean(BASE && KEY);

const num = (name, fallback) => {
	const value = Number(process.env[name]);
	return Number.isInteger(value) && value >= 0 ? value : fallback;
};

const RULES = {
	reel: num("WALLET_REEL_CREDITS", 2),
	longReel: num("WALLET_LONG_REEL_CREDITS", 5),
	longReelSec: num("WALLET_LONG_REEL_SEC", 30) || 30,
	referrer: num("WALLET_REFERRER_CREDITS", 20),
	newUser: num("WALLET_NEW_USER_CREDITS", 10),
	chat: num("WALLET_CHAT_CREDITS", 5),
	chatAfterMessages: num("WALLET_CHAT_AFTER_MESSAGES", 3) || 3
};
const REEL_DAILY_MAX = num("WALLET_REEL_DAILY_MAX", 50);
const CHAT_CHARGE = process.env.WALLET_CHAT_CHARGE === "1";
const MIN_WATCH_MS = 3000; // isse kam mein "poori reel" nahi maani jaayegi
const REF_CODE = /^[\w-]{4,32}$/;

async function call(path, { method = "GET", body } = {}) {
	const response = await fetch(`${BASE}${path}`, {
		method,
		headers: { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(10000)
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`Supabase ${response.status}: ${text.slice(0, 300)}`);
	return text ? JSON.parse(text) : null;
}
const rpc = (name, args) => call(`/rest/v1/rpc/${name}`, { method: "POST", body: args });

const ensureWallet = (uid) => rpc("wallet_ensure", { p_uid: uid });
const addCredits = (uid, amount, reason, once) => rpc("wallet_add", { p_uid: uid, p_amount: amount, p_reason: reason, p_once: once || null });
const spendCredits = (uid, amount, reason) => rpc("wallet_spend", { p_uid: uid, p_amount: amount, p_reason: reason });

async function loadHistory(uid) {
	const rows = await call(`/rest/v1/wallet_ledger?select=reason,amount,created_at&uid=eq.${encodeURIComponent(uid)}&order=created_at.desc&limit=20`);
	return rows.map((row) => ({ reason: row.reason, amount: row.amount, at: row.created_at }));
}

export function createWallet({ send, clients, endPrivateChat }) {
	const dailyReels = new Map(); // "uid:YYYY-MM-DD" -> count
	const matchStates = new Map(); // matchId -> { womanMessages, charged }

	const today = () => new Date().toISOString().slice(0, 10);

	function socketsOf(uid) {
		return [...clients].filter((client) => client.uid === uid);
	}

	async function pushWallet(socket, extra = {}) {
		if (!walletEnabled || !socket.uid) return;
		const wallet = await ensureWallet(socket.uid);
		send(socket, { type: "wallet", credits: wallet.credits, referralCode: wallet.referral_code, rules: RULES, ...extra });
	}

	async function dashboard(socket) {
		if (!walletEnabled) {
			send(socket, { type: "wallet-dashboard", enabled: false });
			return;
		}
		if (!socket.uid) {
			send(socket, { type: "wallet-dashboard", enabled: true, signedIn: false, rules: RULES });
			return;
		}
		const [wallet, history] = await Promise.all([ensureWallet(socket.uid), loadHistory(socket.uid)]);
		send(socket, { type: "wallet-dashboard", enabled: true, signedIn: true, credits: wallet.credits, referralCode: wallet.referral_code, rules: RULES, history });
	}

	async function reelWatched(socket, payload) {
		const reelId = typeof payload.reelId === "string" ? payload.reelId : "";
		const phase = payload.phase;
		if (!isUuid(reelId) || (phase !== "start" && phase !== "end")) return;
		if (!socket.uid) {
			if (phase === "start") send(socket, { type: "reel-reward", rewarded: false, reason: "login-required" });
			return;
		}
		socket.reelStarts = socket.reelStarts || new Map();
		if (phase === "start") {
			if (socket.reelStarts.size >= 50) socket.reelStarts.delete(socket.reelStarts.keys().next().value);
			socket.reelStarts.set(reelId, Date.now());
			return;
		}
		const startedAt = socket.reelStarts.get(reelId);
		socket.reelStarts.delete(reelId);
		if (!startedAt) return;
		const elapsed = Date.now() - startedAt;
		if (elapsed < MIN_WATCH_MS) return;

		const dayKey = `${socket.uid}:${today()}`;
		const count = dailyReels.get(dayKey) || 0;
		if (count >= REEL_DAILY_MAX) {
			send(socket, { type: "reel-reward", rewarded: false, reason: "daily-limit" });
			return;
		}
		// Sirf asli reel par reward (nakli id se farming nahi).
		if (!reelsStoreEnabled || !(await getReel(reelId))) return;

		const amount = elapsed >= RULES.longReelSec * 1000 * 0.9 ? RULES.longReel : RULES.reel;
		if (amount <= 0) return;
		const balance = await addCredits(socket.uid, amount, `reel:${reelId}`, `reel:${reelId}`);
		if (balance < 0) {
			send(socket, { type: "reel-reward", rewarded: false, reason: "already-rewarded" });
			return;
		}
		dailyReels.set(dayKey, count + 1);
		send(socket, { type: "reel-reward", rewarded: true, credits: amount });
		await pushWallet(socket);
	}

	// set-profile ke baad: balance bhejo, aur ?ref= code ho to welcome bonus do.
	async function profileSaved(socket, ref) {
		if (!walletEnabled || !socket.uid) return;
		if (typeof ref === "string" && REF_CODE.test(ref) && !socket.refTried) {
			socket.refTried = true;
			const referrer = await rpc("wallet_link_referral", { p_uid: socket.uid, p_code: ref });
			if (referrer && RULES.newUser > 0) {
				const balance = await addCredits(socket.uid, RULES.newUser, "referral-welcome", "referral-welcome");
				if (balance >= 0) send(socket, { type: "referral-bonus", role: "invitee", credits: RULES.newUser });
			}
		}
		await pushWallet(socket);
	}

	async function payReferral(sender) {
		const referrer = await rpc("wallet_referral_payout", { p_uid: sender.uid });
		if (!referrer || RULES.referrer <= 0) return;
		const balance = await addCredits(referrer, RULES.referrer, `referral:${sender.uid}`, `referral:${sender.uid}`);
		if (balance < 0) return;
		for (const client of socketsOf(referrer)) {
			send(client, { type: "referral-bonus", role: "referrer", credits: RULES.referrer });
			pushWallet(client).catch(() => {});
		}
	}

	async function chargeForWoman(receiver) {
		const balance = await spendCredits(receiver.uid, RULES.chat, "chat-with-woman");
		if (balance < 0) {
			send(receiver, { type: "need-credits", message: `Not enough credits to keep chatting. You need ${RULES.chat} credits. Watch reels to earn more.` });
			if (receiver.peer) {
				endPrivateChat(receiver);
				send(receiver, { type: "private-left" });
			}
			return;
		}
		await pushWallet(receiver, { charged: RULES.chat });
	}

	// Private chat mein sender ne message bheja (receiver = uska partner).
	async function privateMessage(sender, receiver) {
		if (!walletEnabled) return;
		if (sender.uid) await payReferral(sender);
		if (!CHAT_CHARGE || !receiver || !sender.matchId) return;
		if (sender.profile?.gender !== "Woman" || receiver.profile?.gender === "Woman" || !receiver.uid) return; // guest ko charge nahi
		let state = matchStates.get(sender.matchId);
		if (!state) {
			state = { womanMessages: 0, charged: false };
			matchStates.set(sender.matchId, state);
			while (matchStates.size > 2000) matchStates.delete(matchStates.keys().next().value);
		}
		state.womanMessages += 1;
		if (state.charged || state.womanMessages < RULES.chatAfterMessages) return;
		state.charged = true;
		await chargeForWoman(receiver);
	}

	const guard = (promise) => promise.catch((error) => console.error("Wallet error:", error.message));

	return {
		// true = ye wallet ka message tha aur handle ho gaya
		handle(socket, payload) {
			if (payload.type === "get-wallet") {
				guard(dashboard(socket));
				return true;
			}
			if (payload.type === "reel-watched") {
				guard(reelWatched(socket, payload));
				return true;
			}
			return false;
		},
		onProfile(socket, ref) {
			guard(profileSaved(socket, ref));
		},
		onPrivateMessage(sender, receiver) {
			guard(privateMessage(sender, receiver));
		}
	};
}
