// Credits / wallet (Supabase). Sirf Gmail (Firebase) se sign-in kiye users ke credits hote hain.
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim(); // sirf Render par, frontend me kabhi nahi
export const walletEnabled = Boolean(SUPABASE_URL && SUPABASE_KEY);

const envNumber = (name, fallback) => {
	const raw = process.env[name];
	const value = Number(raw);
	return raw !== undefined && raw !== "" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
};

// Rules yahin se (ya Render Environment se) badlo.
export const COSTS = {
	reel: envNumber("CREDITS_REEL", 5),               // normal reel
	longReel: envNumber("CREDITS_LONG_REEL", 8),      // reel 50 sec se lambi
	longReelSec: envNumber("LONG_REEL_SECONDS", 50),
	chat: envNumber("CREDITS_CHAT_WOMAN", 30),        // Woman se chat khatam hone par katega
	chatAfterMessages: envNumber("CHARGE_AFTER_WOMAN_MESSAGES", 4), // credit tabhi katega jab Woman ke itne messages aa chuke hon
	// Reel ka kitna hissa dekhna zaroori hai (0.9 = 90%). Server wall-clock se bhi check karta hai.
	watchFraction: (() => { const v = Number(process.env.REEL_WATCH_FRACTION); return v >= 0.5 && v <= 1 ? v : 0.9; })(),
	referrer: envNumber("CREDITS_REFERRER", 150),     // old user
	newUser: envNumber("CREDITS_NEW_USER", 100)       // new user
};

// Reel ki duration Supabase ke reels table se aati hai (client par bharosa nahi).
const REELS_TABLE = process.env.REELS_TABLE || "reels";
const REELS_ID_COLUMN = process.env.REELS_ID_COLUMN || "id";
const REELS_DURATION_COLUMN = process.env.REELS_DURATION_COLUMN || "duration"; // seconds

const headers = () => ({ apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}`, "content-type": "application/json" });

async function rpc(name, args) {
	const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify(args),
		signal: AbortSignal.timeout(8000)
	});
	if (!response.ok) throw new Error(`Supabase ${name} failed (${response.status}): ${(await response.text()).replace(/\s+/g, " ").slice(0, 200)}`);
	return response.json();
}

async function restGet(path) {
	const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: headers(), signal: AbortSignal.timeout(8000) });
	if (!response.ok) throw new Error(`Supabase read failed (${response.status})`);
	return response.json();
}

const publicRules = () => ({
	reel: COSTS.reel, longReel: COSTS.longReel, longReelSec: COSTS.longReelSec,
	chat: COSTS.chat, chatAfterMessages: COSTS.chatAfterMessages,
	referrer: COSTS.referrer, newUser: COSTS.newUser
});

async function getReel(reelId) {
	const query = new URLSearchParams({ select: REELS_DURATION_COLUMN, [REELS_ID_COLUMN]: `eq.${reelId}`, limit: "1" });
	const response = await fetch(`${SUPABASE_URL}/rest/v1/${REELS_TABLE}?${query}`, { headers: headers(), signal: AbortSignal.timeout(8000) });
	if (!response.ok) throw new Error(`Reel lookup failed (${response.status}). REELS_TABLE / column names check karo.`);
	const rows = await response.json();
	if (!rows.length) return null;
	const duration = Number(rows[0][REELS_DURATION_COLUMN]);
	return { duration: Number.isFinite(duration) ? duration : 0 };
}

// Woman se match hone par paise wahi deta hai jo Woman nahi hai. Dono Woman ya dono non-Woman: koi nahi.
export function chatPayer(a, b) {
	const aWoman = a.profile?.gender === "Woman";
	const bWoman = b.profile?.gender === "Woman";
	if (aWoman === bWoman) return null;
	return aWoman ? b : a;
}

// Matching ke time: payer ke paas kam se kam chat cost jitne credits hone chahiye.
export function canAffordChat(a, b) {
	if (!walletEnabled) return true;
	const payer = chatPayer(a, b);
	return !payer || payer.credits >= COSTS.chat;
}

export function createWallet({ clients, send }) {
	// "Women only" chunne wala (jo khud Woman nahi) 30 credit ke bina queue me nahi jaa sakta.
	function blockWomenQueue(socket) {
		if (!walletEnabled || socket.matchPreference !== "women" || socket.profile?.gender === "Woman" || socket.credits >= COSTS.chat) return false;
		send(socket, {
			type: "need-credits",
			needed: COSTS.chat,
			balance: socket.credits,
			signedIn: Boolean(socket.uid),
			message: socket.uid
				? `Women se chat ke liye ${COSTS.chat} credits chahiye. Reels dekh kar credits kamao.`
				: "Women se chat ke liye Gmail se sign-in karo aur credits kamao."
		});
		return true;
	}

	async function loginWallet(socket, account, ref) {
		if (!walletEnabled) return;
		try {
			const wallet = await rpc("wallet_login", { p_uid: account.uid, p_email: account.email, p_ref: typeof ref === "string" ? ref.slice(0, 32) : null });
			socket.credits = wallet.credits;
			socket.referralCode = wallet.referralCode;
			socket.pendingReferral = Boolean(wallet.pendingReferral);
			send(socket, { type: "wallet", credits: wallet.credits, referralCode: wallet.referralCode, chatCost: COSTS.chat, rules: publicRules() });
		} catch (error) {
			console.error("Wallet login failed:", error.message);
		}
	}

	// Reel credit sirf poori reel dekhne par: client "start" bhejta hai, phir "end".
	// Server khud check karta hai ki start se ab tak reel ki duration (watchFraction) jitna time beet chuka hai.
	async function handleReelWatched(socket, payload) {
		if (!walletEnabled) return;
		if (!socket.uid) {
			send(socket, { type: "reel-reward", rewarded: false, reason: "login-required" });
			return;
		}
		const reelId = typeof payload.reelId === "string" || typeof payload.reelId === "number" ? String(payload.reelId) : "";
		if (!/^[\w-]{1,64}$/.test(reelId)) return;

		socket.reelStarts = socket.reelStarts || new Map();
		if (payload.phase === "start") {
			if (!socket.reelStarts.has(reelId)) {
				if (socket.reelStarts.size >= 50) socket.reelStarts.delete(socket.reelStarts.keys().next().value);
				socket.reelStarts.set(reelId, Date.now());
			}
			return;
		}

		const now = Date.now();
		socket.reelTimes = (socket.reelTimes || []).filter((at) => now - at < 10000);
		if (socket.reelTimes.length >= 10) return;
		socket.reelTimes.push(now);

		const startedAt = socket.reelStarts.get(reelId);
		if (!startedAt) {
			send(socket, { type: "reel-reward", reelId, rewarded: false, reason: "not-started" });
			return;
		}
		try {
			const reel = await getReel(reelId);
			if (!reel) {
				send(socket, { type: "reel-reward", reelId, rewarded: false, reason: "unknown-reel" });
				return;
			}
			const needMs = Math.max(reel.duration || 15, 3) * 1000 * COSTS.watchFraction;
			const elapsed = Date.now() - startedAt;
			if (elapsed < needMs) {
				send(socket, { type: "reel-reward", reelId, rewarded: false, reason: "not-finished", remainingMs: Math.ceil(needMs - elapsed) });
				return;
			}
			const credits = reel.duration > COSTS.longReelSec ? COSTS.longReel : COSTS.reel;
			const result = await rpc("wallet_reel", { p_uid: socket.uid, p_reel: reelId, p_credits: credits });
			socket.reelStarts.delete(reelId);
			socket.credits = result.balance;
			send(socket, { type: "reel-reward", reelId, rewarded: result.rewarded, credits: result.rewarded ? credits : 0, balance: result.balance });
		} catch (error) {
			console.error("Reel reward failed:", error.message);
			send(socket, { type: "reel-reward", reelId, rewarded: false, reason: "server-error" });
		}
	}

	// Dashboard: balance, referral code, rules aur pichli 20 entries.
	async function handleGetWallet(socket) {
		if (!walletEnabled) {
			send(socket, { type: "wallet-dashboard", enabled: false });
			return;
		}
		if (!socket.uid) {
			send(socket, { type: "wallet-dashboard", enabled: true, signedIn: false, rules: publicRules() });
			return;
		}
		const now = Date.now();
		if (socket.lastWalletAt && now - socket.lastWalletAt < 1500) return;
		socket.lastWalletAt = now;
		try {
			const uid = encodeURIComponent(socket.uid);
			const [wallets, log] = await Promise.all([
				restGet(`wallets?uid=eq.${uid}&select=credits,referral_code`),
				restGet(`credit_log?uid=eq.${uid}&select=amount,reason,created_at&order=created_at.desc&limit=20`)
			]);
			const row = wallets[0];
			if (!row) return;
			socket.credits = row.credits;
			send(socket, {
				type: "wallet-dashboard", enabled: true, signedIn: true,
				credits: row.credits, referralCode: row.referral_code,
				history: log.map((entry) => ({ amount: entry.amount, reason: entry.reason, at: entry.created_at })),
				rules: publicRules()
			});
		} catch (error) {
			console.error("Wallet dashboard failed:", error.message);
		}
	}

	// Chat khatam: payer ke 30 credit kato (balance se zyada nahi).
	async function chargeForChat(socket, peer) {
		if (!walletEnabled || !peer) return;
		const payer = chatPayer(socket, peer);
		if (!payer || !payer.uid) return;
		// Credit sirf tab katega jab Woman ne is chat me kam se kam 4 messages bheje hon.
		const woman = payer === socket ? peer : socket;
		if ((woman.matchMessages || 0) < COSTS.chatAfterMessages) return;
		try {
			const result = await rpc("wallet_charge", { p_uid: payer.uid, p_amount: COSTS.chat, p_reason: "chat-with-woman" });
			if (!result) return;
			payer.credits = result.balance;
			send(payer, { type: "wallet", credits: result.balance, charged: result.charged });
		} catch (error) {
			console.error("Chat charge failed:", error.message);
		}
	}

	// Naya user (referral link se aaya) jab pehli baar kisi insaan se connect ho: 150 old + 100 new, sirf ek baar.
	async function claimReferral(socket) {
		if (!walletEnabled || !socket.uid || !socket.pendingReferral) return;
		socket.pendingReferral = false;
		try {
			const result = await rpc("wallet_referral", { p_uid: socket.uid, p_referrer_bonus: COSTS.referrer, p_new_bonus: COSTS.newUser });
			if (!result) return;
			socket.credits = result.balance;
			send(socket, { type: "referral-bonus", role: "new", credits: COSTS.newUser, balance: result.balance });
			for (const client of clients) {
				if (client.uid === result.referrer) {
					client.credits = result.referrerBalance;
					send(client, { type: "referral-bonus", role: "referrer", credits: COSTS.referrer, balance: result.referrerBalance });
				}
			}
		} catch (error) {
			socket.pendingReferral = true; // dobara try ho sake
			console.error("Referral claim failed:", error.message);
		}
	}

	return { blockWomenQueue, loginWallet, handleReelWatched, handleGetWallet, chargeForChat, claimReferral };
}
