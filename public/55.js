// Strangely wallet: credits, paid listener chats, kamaai, recharge (Razorpay) aur withdrawal.
//
// Rules (jo site par bhi dikhte hain):
//  - Seeker 1 connect ke CONNECT_COST credits deta hai (default 400 = Rs 1.56). Chat max 7 minute.
//  - Listener ko us kharch ka max 35% milta hai (140 credits), sirf asli texts par.
//  - Listener ne 3 asli reply nahi diye to seeker ke credits poore wapas.
//  - AI chat kabhi charge nahi hoti aur kabhi payout nahi deti.
//  - Kamaai ki hold 3 din ki FIXED hai, apne aap khulti hai. Referral ya recharge se koi connection nahi.
//  - Credits (kharide hue / bonus) withdraw nahi hote. Sirf listener kamaai withdraw hoti hai.
import { createHmac, createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import * as realStore from "./store.js";

const num = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);

export const CONFIG = {
	connectCost: num(process.env.CONNECT_COST, 400),
	chatMaxMs: num(process.env.CHAT_MAX_MINUTES, 7) * 60 * 1000,
	listenerMaxEarn: num(process.env.LISTENER_MAX_EARN, 140), // 400 ka 35%
	creditsPerText: num(process.env.CREDITS_PER_TEXT, 7),
	minValidTexts: 3,
	holdMs: num(process.env.WITHDRAW_HOLD_DAYS, 3) * 24 * 60 * 60 * 1000,
	minWithdrawPaise: Math.round(num(process.env.MIN_WITHDRAW_RUPEES, 50) * 100),
	signupBonus: num(process.env.SIGNUP_BONUS_CREDITS, 1000),
	signupBonusLimit: num(process.env.SIGNUP_BONUS_LIMIT, 200),
	refReferrer: 400,
	refNew: 300,
	dailyEarnCap: num(process.env.LISTENER_DAILY_CAP_CREDITS, 7000),
	seekWaitMs: 90 * 1000,
	allowSameIp: process.env.ALLOW_SAME_IP === "true"
};

// 10,000 credits = Rs 39  =>  100 credits = 39 paise
export const toPaise = (credits) => Math.floor((Number(credits) || 0) * 39 / 100);

export const PACKS = [
	{ id: "p39", paise: 3900, credits: 10000 },
	{ id: "p99", paise: 9900, credits: 27000 },
	{ id: "p199", paise: 19900, credits: 56000 }
];

const UPI_PATTERN = /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z]{2,32}$/;

function safeEqual(a, b) {
	const left = createHash("sha256").update(String(a)).digest();
	const right = createHash("sha256").update(String(b)).digest();
	return timingSafeEqual(left, right);
}

function readBody(request, limit = 65536) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		request.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error("body too large"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolve(Buffer.concat(chunks)));
		request.on("error", reject);
	});
}

const ADMIN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Withdrawals</title>
<style>body{font:14px system-ui;margin:20px;color:#1f2a44}table{border-collapse:collapse;width:100%}td,th{border:1px solid #dfe5f3;padding:8px;text-align:left}button{margin-right:6px;padding:6px 10px}</style></head>
<body><h2>Withdrawal requests</h2><p>Pehle UPI se paisa bhejo, phir "Paid" dabao. Galat ho to "Reject" (credits wapas kamaai me chale jaate hain).</p>
<div id="out">Loading...</div>
<script>
var token = sessionStorage.getItem("admin-token") || prompt("Admin token");
if (token) sessionStorage.setItem("admin-token", token);
function api(path, opts) { opts = opts || {}; opts.headers = Object.assign({ "x-admin-token": token, "content-type": "application/json" }, opts.headers || {}); return fetch(path, opts).then(function (r) { return r.json(); }); }
function cell(row, text) { var td = document.createElement("td"); td.textContent = text; row.appendChild(td); return td; }
function load() {
  api("/admin/api/withdrawals?status=requested").then(function (data) {
    var out = document.getElementById("out"); out.textContent = "";
    if (!data.ok) { out.textContent = "Token galat hai ya server band hai."; sessionStorage.removeItem("admin-token"); return; }
    if (!data.items.length) { out.textContent = "Koi pending request nahi."; return; }
    var table = document.createElement("table"), head = table.insertRow();
    ["ID", "Amount (Rs)", "UPI", "Time", "Action"].forEach(function (h) { var th = document.createElement("th"); th.textContent = h; head.appendChild(th); });
    data.items.forEach(function (item) {
      var row = table.insertRow();
      cell(row, item.id); cell(row, (item.amount_paise / 100).toFixed(2)); cell(row, item.upi); cell(row, new Date(item.created_at).toLocaleString());
      var td = cell(row, "");
      [["paid", "Paid"], ["reject", "Reject"]].forEach(function (pair) {
        var b = document.createElement("button"); b.textContent = pair[1];
        b.onclick = function () {
          var note = pair[0] === "reject" ? (prompt("Reject ka reason (user ko nahi dikhta)") || "") : "";
          api("/admin/api/withdrawals/" + item.id + "/" + pair[0], { method: "POST", body: JSON.stringify({ note: note }) }).then(load);
        };
        td.appendChild(b);
      });
    });
    out.appendChild(table);
  });
}
load();
</script></body></html>`;

export function createWallet(deps, store = realStore) {
	const { send, clients, canMatch, connectGuests, endPrivateChat, removeFromQueue } = deps;
	const enabled = Boolean(store.storeEnabled);
	const RZP_KEY = (process.env.RAZORPAY_KEY_ID || "").trim();
	const RZP_SECRET = (process.env.RAZORPAY_KEY_SECRET || "").trim();
	const RZP_WEBHOOK_SECRET = (process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();
	const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();
	const paymentsReady = Boolean(RZP_KEY && RZP_SECRET);

	const seekers = [];
	const listeners = [];
	const dailyEarned = new Map(); // uid -> { day, credits }
	let pairing = false;
	let repair = false;

	if (!enabled) console.log("Wallet is OFF (SUPABASE_URL / SUPABASE_SERVICE_KEY not set). Chat works as before, free.");
	else console.log(`Wallet is ON. Payments ${paymentsReady ? "ready" : "NOT configured (Razorpay keys missing)"}.`);

	const alive = (socket) => socket.readyState === WebSocket.OPEN && !socket.peer;
	const removeFrom = (list, item) => {
		const index = list.indexOf(item);
		if (index === -1) return false;
		list.splice(index, 1);
		return true;
	};

	function staticInfo() {
		return {
			packs: PACKS.map((pack) => ({ id: pack.id, rupees: pack.paise / 100, credits: pack.credits })),
			cost: CONFIG.connectCost,
			costPaise: toPaise(CONFIG.connectCost),
			maxMinutes: Math.round(CONFIG.chatMaxMs / 60000),
			listenerMax: CONFIG.listenerMaxEarn,
			listenerMaxPaise: toPaise(CONFIG.listenerMaxEarn),
			minWithdrawRupees: CONFIG.minWithdrawPaise / 100,
			holdDays: Math.round(CONFIG.holdMs / 86400000),
			minValidTexts: CONFIG.minValidTexts,
			payments: paymentsReady,
			rzpKeyId: paymentsReady ? RZP_KEY : ""
		};
	}

	async function pushState(socket, extra = {}) {
		if (!enabled) {
			send(socket, { type: "wallet-state", enabled: false });
			return;
		}
		if (!socket.uid) {
			send(socket, { type: "wallet-state", enabled: true, signedIn: false, ...staticInfo() });
			return;
		}
		const wallet = await store.getWallet(socket.uid);
		send(socket, {
			type: "wallet-state",
			enabled: true,
			signedIn: true,
			credits: Number(wallet.credits),
			earnPaise: toPaise(wallet.earn_credits),
			pendingPaise: toPaise(wallet.pending_credits),
			code: wallet.code,
			hasReferrer: Boolean(wallet.referred_by),
			listening: socket.listening === true,
			...staticInfo(),
			...extra
		});
	}

	function notice(socket, message) {
		send(socket, { type: "wallet-notice", message });
	}

	function fail(socket, message) {
		send(socket, { type: "wallet-error", message });
	}

	async function ensureSignupBonus(socket) {
		if (socket.bonusChecked) return;
		socket.bonusChecked = true;
		const given = await store.countKind("signup_bonus");
		if (given < CONFIG.signupBonusLimit) await store.applyDelta(socket.uid, CONFIG.signupBonus, 0, "signup_bonus", socket.uid);
	}

	// ---------- Recharge ----------
	async function createOrder(socket, packId) {
		const pack = PACKS.find((item) => item.id === packId);
		if (!pack) return fail(socket, "Ye pack available nahi hai.");
		if (!paymentsReady) return fail(socket, "Payments abhi chalu nahi hain.");
		const response = await fetch("https://api.razorpay.com/v1/orders", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`${RZP_KEY}:${RZP_SECRET}`).toString("base64")}` },
			body: JSON.stringify({ amount: pack.paise, currency: "INR", receipt: `rc_${Date.now()}`, notes: { pack: pack.id } }),
			signal: AbortSignal.timeout(15000)
		});
		const order = await response.json();
		if (!response.ok || !order.id) {
			console.error("Razorpay order failed:", response.status, JSON.stringify(order).slice(0, 300));
			return fail(socket, "Order nahi ban saka. Thodi der baad try karo.");
		}
		await store.insertRecharge({ order_id: order.id, uid: socket.uid, pack: pack.id, amount_paise: pack.paise, credits: pack.credits });
		send(socket, { type: "wallet-order", orderId: order.id, amount: pack.paise, keyId: RZP_KEY, credits: pack.credits });
	}

	async function maybeRewardReferral(uid) {
		const claim = await store.claimReferral(uid);
		if (!claim || !claim.ok) return;
		await store.applyDelta(uid, CONFIG.refNew, 0, "referral_welcome", uid);
		await store.applyDelta(claim.referrer, CONFIG.refReferrer, 0, "referral_reward", uid);
	}

	async function creditRecharge(orderId, paymentId) {
		const result = await store.rechargeCredit(orderId, paymentId);
		if (!result || !result.ok) return result || { ok: false };
		if (result.first) await maybeRewardReferral(result.uid);
		for (const client of clients) {
			if (client.uid === result.uid) pushState(client).catch(() => {});
		}
		return result;
	}

	async function verifyPayment(socket, payload) {
		const orderId = String(payload.orderId || "");
		const paymentId = String(payload.paymentId || "");
		const signature = String(payload.signature || "");
		if (!orderId || !paymentId || !signature || !paymentsReady) return fail(socket, "Payment verify nahi ho saka.");
		const expected = createHmac("sha256", RZP_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
		if (!safeEqual(expected, signature)) return fail(socket, "Payment signature galat hai.");
		const recharge = await store.getRecharge(orderId);
		if (!recharge || recharge.uid !== socket.uid) return fail(socket, "Ye order aapka nahi hai.");
		const result = await creditRecharge(orderId, paymentId);
		if (result && result.ok) notice(socket, `${Number(result.credits).toLocaleString("en-IN")} credits add ho gaye.`);
		else notice(socket, "Ye payment pehle hi add ho chuka hai.");
		await pushState(socket);
	}

	// ---------- Withdrawal / referral ----------
	async function withdraw(socket, payload) {
		const upi = String(payload.upi || "").trim();
		if (!UPI_PATTERN.test(upi)) return fail(socket, "Sahi UPI ID daalo (jaise name@bank).");
		const result = await store.requestWithdrawal(socket.uid, upi, CONFIG.minWithdrawPaise);
		if (result && result.ok) notice(socket, `Withdrawal request mil gayi: Rs ${(result.paise / 100).toFixed(2)}. Owner UPI par bhejega.`);
		else if (result && result.reason === "below_minimum") fail(socket, `Minimum Rs ${CONFIG.minWithdrawPaise / 100} chahiye. Abhi available: Rs ${(result.paise / 100).toFixed(2)}.`);
		else fail(socket, "Withdrawal nahi ho saka.");
		await pushState(socket);
	}

	async function applyReferral(socket, payload) {
		const code = String(payload.code || "").trim().toUpperCase();
		if (!/^[A-Z0-9]{4,16}$/.test(code)) return fail(socket, "Sahi referral code daalo.");
		const result = await store.setReferral(socket.uid, code);
		const messages = {
			already_set: "Aapne pehle hi referral code laga diya hai.",
			already_recharged: "Referral code sirf pehle recharge se pehle lag sakta hai.",
			bad_code: "Ye code nahi mila.",
			self: "Apna code khud nahi laga sakte."
		};
		if (result && result.ok) notice(socket, `Code lag gaya. Pehle recharge par aapko ${CONFIG.refNew} credits milenge.`);
		else fail(socket, messages[result && result.reason] || "Code nahi lag saka.");
		await pushState(socket);
	}

	// ---------- Paid chat matching ----------
	function capLeft(uid) {
		const day = new Date().toISOString().slice(0, 10);
		const entry = dailyEarned.get(uid);
		const used = entry && entry.day === day ? entry.credits : 0;
		return Math.max(0, CONFIG.dailyEarnCap - used);
	}

	function addDaily(uid, credits) {
		const day = new Date().toISOString().slice(0, 10);
		const entry = dailyEarned.get(uid);
		dailyEarned.set(uid, { day, credits: (entry && entry.day === day ? entry.credits : 0) + credits });
	}

	function dropFromQueues(socket) {
		const wasListening = removeFrom(listeners, socket);
		removeFrom(seekers, socket);
		clearTimeout(socket.seekTimer);
		socket.seekTimer = null;
		if (wasListening || socket.listening) {
			socket.listening = false;
			send(socket, { type: "listening", on: false });
		}
	}

	async function settle(paid) {
		if (paid.settled) return;
		paid.settled = true;
		clearTimeout(paid.timer);
		if (paid.seeker.paid === paid) paid.seeker.paid = null;
		if (paid.listener.paid === paid) paid.listener.paid = null;
		try {
			const good = paid.seekerTexts >= 2 && paid.listenerValid >= CONFIG.minValidTexts;
			if (good) {
				let earn = Math.min(CONFIG.listenerMaxEarn, paid.listenerValid * CONFIG.creditsPerText);
				earn = Math.min(earn, capLeft(paid.listenerUid));
				if (earn > 0) {
					await store.addLot(paid.listenerUid, earn, new Date(Date.now() + CONFIG.holdMs).toISOString(), paid.id);
					addDaily(paid.listenerUid, earn);
				}
				send(paid.seeker, { type: "paid-settled", role: "seeker", refunded: false, charged: CONFIG.connectCost });
				send(paid.listener, { type: "paid-settled", role: "listener", earnedCredits: earn, earnedPaise: toPaise(earn), holdDays: Math.round(CONFIG.holdMs / 86400000) });
			} else {
				await store.applyDelta(paid.seekerUid, CONFIG.connectCost, 0, "connect_refund", paid.id);
				send(paid.seeker, { type: "paid-settled", role: "seeker", refunded: true, charged: 0 });
				send(paid.listener, { type: "paid-settled", role: "listener", earnedCredits: 0, earnedPaise: 0, holdDays: 0 });
			}
		} catch (error) {
			// Is log ko dhyan se dekhna: chat id ke saath manually theek kar sakte ho.
			console.error(`SETTLEMENT FAILED for paid chat ${paid.id} (seeker ${paid.seekerUid}, listener ${paid.listenerUid}):`, error.message);
		}
		pushState(paid.seeker).catch(() => {});
		pushState(paid.listener).catch(() => {});
	}

	function onTimeout(paid) {
		if (paid.settled) return;
		const { seeker, listener } = paid;
		endPrivateChat(seeker);
		send(seeker, { type: "private-left" });
		send(seeker, { type: "paid-timeout" });
		send(listener, { type: "paid-timeout" });
	}

	async function startPaidChat(seeker, listener) {
		const id = randomUUID();
		const charge = await store.applyDelta(seeker.uid, -CONFIG.connectCost, 0, "connect_charge", id);
		if (!charge || !charge.ok) {
			fail(seeker, "Credits kam hain. Recharge karke dobara try karo.");
			send(seeker, { type: "match-cancelled" });
			listeners.unshift(listener);
			listener.listening = true;
			return;
		}
		if (!alive(seeker) || !alive(listener)) {
			await store.applyDelta(seeker.uid, CONFIG.connectCost, 0, "connect_refund", id);
			if (alive(listener)) {
				listeners.unshift(listener);
				listener.listening = true;
			}
			if (seeker.readyState === WebSocket.OPEN) {
				send(seeker, { type: "match-cancelled" });
				notice(seeker, "Match poora nahi hua. Aapke credits wapas hain, dobara try karo.");
				pushState(seeker).catch(() => {});
			}
			return;
		}
		const paid = {
			id, seeker, listener, seekerUid: seeker.uid, listenerUid: listener.uid,
			seekerTexts: 0, listenerValid: 0, lastListenerText: "", lastValidAt: 0, settled: false,
			timer: null, endsAt: Date.now() + CONFIG.chatMaxMs
		};
		seeker.paid = paid;
		listener.paid = paid;
		listener.listening = false;
		paid.timer = setTimeout(() => onTimeout(paid), CONFIG.chatMaxMs);
		connectGuests(seeker, listener);
		send(listener, { type: "listening", on: false });
		send(seeker, { type: "paid-match", role: "seeker", endsAt: paid.endsAt, cost: CONFIG.connectCost });
		send(listener, { type: "paid-match", role: "listener", endsAt: paid.endsAt, maxEarn: CONFIG.listenerMaxEarn, maxEarnPaise: toPaise(CONFIG.listenerMaxEarn) });
		pushState(seeker).catch(() => {});
	}

	async function tryPair() {
		if (pairing) {
			repair = true;
			return;
		}
		pairing = true;
		try {
			do {
				repair = false;
				for (const seeker of [...seekers]) {
					if (!alive(seeker)) {
						dropFromQueues(seeker);
						continue;
					}
					const listener = listeners.find((candidate) =>
						candidate !== seeker && alive(candidate) && candidate.uid !== seeker.uid &&
						canMatch(seeker, candidate) && (CONFIG.allowSameIp || candidate.ip !== seeker.ip));
					if (!listener) continue;
					removeFrom(seekers, seeker);
					removeFrom(listeners, listener);
					clearTimeout(seeker.seekTimer);
					seeker.seekTimer = null;
					await startPaidChat(seeker, listener);
				}
			} while (repair);
		} finally {
			pairing = false;
		}
	}

	async function findPaid(socket, payload) {
		if (payload.preference !== "any" && payload.preference !== "women") return fail(socket, "Sahi match preference chuno.");
		const wallet = await store.getWallet(socket.uid);
		if (Number(wallet.credits) < CONFIG.connectCost) {
			fail(socket, `Ek connect ke ${CONFIG.connectCost} credits chahiye. Recharge karo.`);
			await pushState(socket);
			return;
		}
		if (socket.peer) endPrivateChat(socket);
		socket.ai = null;
		removeFromQueue(socket);
		socket.matchPreference = payload.preference;
		seekers.push(socket);
		send(socket, { type: "queued", position: seekers.length });
		socket.seekTimer = setTimeout(() => {
			if (!removeFrom(seekers, socket)) return;
			socket.seekTimer = null;
			send(socket, { type: "match-cancelled" });
			notice(socket, "Abhi koi listener online nahi hai. Credits nahi kate. Thodi der baad try karo, ya free random chat / AI use karo.");
		}, CONFIG.seekWaitMs);
		await tryPair();
	}

	async function startListening(socket) {
		if (socket.peer) return fail(socket, "Pehle current chat khatam karo.");
		socket.ai = null;
		removeFromQueue(socket);
		listeners.push(socket);
		socket.listening = true;
		send(socket, { type: "listening", on: true });
		await tryPair();
	}

	function stopListening(socket) {
		dropFromQueues(socket);
	}

	// ---------- Message dispatcher ----------
	const TYPES = new Set(["wallet-get", "wallet-recharge", "wallet-verify", "wallet-withdraw", "wallet-referral", "listen-start", "listen-stop", "find-paid"]);

	async function dispatch(socket, payload) {
		if (!enabled) {
			send(socket, { type: "wallet-state", enabled: false });
			return;
		}
		const now = Date.now();
		socket.walletTimes = (socket.walletTimes || []).filter((at) => now - at < 10000);
		if (socket.walletTimes.length >= 15) return fail(socket, "Thoda ruko, bahut zyada requests.");
		socket.walletTimes.push(now);
		if (!socket.profile) return fail(socket, "Pehle profile set karo.");
		if (!socket.uid) {
			fail(socket, "Credits aur kamaai ke liye Gmail se sign in karna zaroori hai (Edit > Gmail).");
			await pushState(socket);
			return;
		}
		switch (payload.type) {
			case "wallet-get":
				await ensureSignupBonus(socket);
				await pushState(socket);
				break;
			case "wallet-recharge": await createOrder(socket, String(payload.pack || "")); break;
			case "wallet-verify": await verifyPayment(socket, payload); break;
			case "wallet-withdraw": await withdraw(socket, payload); break;
			case "wallet-referral": await applyReferral(socket, payload); break;
			case "find-paid": await findPaid(socket, payload); break;
			case "listen-start": await startListening(socket); break;
			case "listen-stop": stopListening(socket); await pushState(socket); break;
			default: break;
		}
	}

	async function handle(socket, payload) {
		if (!TYPES.has(payload.type)) return false;
		try {
			await dispatch(socket, payload);
		} catch (error) {
			console.error("Wallet error:", error.message);
			fail(socket, "Wallet me dikkat aayi. Thodi der baad try karo.");
		}
		return true;
	}

	// ---------- Hooks jo server.js se chalte hain ----------
	function onChatEnd(socket) {
		const paid = socket.paid;
		if (!paid) return;
		if (paid.settled) {
			socket.paid = null;
			return;
		}
		settle(paid).catch((error) => console.error("settle error:", error.message));
	}

	function onPrivateText(socket, text) {
		const paid = socket.paid;
		if (!paid || paid.settled) return;
		if (socket === paid.seeker) {
			paid.seekerTexts += 1;
			return;
		}
		if (socket !== paid.listener) return;
		const clean = String(text || "").trim();
		const lowered = clean.toLowerCase();
		const now = Date.now();
		// Asli reply: kam se kam 3 akshar, ek letter, pichle jaisa nahi, 2 second ka gap (spam par kamaai nahi).
		if (clean.length >= 3 && /\p{L}/u.test(clean) && lowered !== paid.lastListenerText && now - paid.lastValidAt >= 2000) {
			paid.listenerValid += 1;
			paid.lastListenerText = lowered;
			paid.lastValidAt = now;
		}
	}

	// ---------- HTTP: Razorpay webhook + owner admin ----------
	function json(response, status, body) {
		response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		response.end(JSON.stringify(body));
	}

	function isAdmin(request) {
		return Boolean(ADMIN_TOKEN) && safeEqual(request.headers["x-admin-token"] || "", ADMIN_TOKEN);
	}

	async function http(request, response, pathname) {
		if (!enabled) return false;

		if (pathname === "/razorpay-webhook" && request.method === "POST") {
			try {
				const raw = await readBody(request);
				const signature = String(request.headers["x-razorpay-signature"] || "");
				const expected = RZP_WEBHOOK_SECRET ? createHmac("sha256", RZP_WEBHOOK_SECRET).update(raw).digest("hex") : "";
				if (!expected || !safeEqual(expected, signature)) return json(response, 400, { ok: false }), true;
				const event = JSON.parse(raw.toString("utf8"));
				const payment = event?.payload?.payment?.entity;
				if ((event.event === "payment.captured" || event.event === "order.paid") && payment?.order_id && payment?.id) {
					await creditRecharge(payment.order_id, payment.id);
				}
				json(response, 200, { ok: true });
			} catch (error) {
				console.error("Webhook error:", error.message);
				json(response, 500, { ok: false });
			}
			return true;
		}

		if (pathname === "/admin" && request.method === "GET") {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
			response.end(ADMIN_PAGE);
			return true;
		}

		if (pathname.startsWith("/admin/api/")) {
			if (!isAdmin(request)) return json(response, 401, { ok: false }), true;
			try {
				if (pathname === "/admin/api/withdrawals" && request.method === "GET") {
					const status = new URL(request.url, "http://localhost").searchParams.get("status") || "requested";
					json(response, 200, { ok: true, items: await store.listWithdrawals(status) });
					return true;
				}
				const match = pathname.match(/^\/admin\/api\/withdrawals\/(\d+)\/(paid|reject)$/);
				if (match && request.method === "POST") {
					const body = JSON.parse((await readBody(request)).toString("utf8") || "{}");
					json(response, 200, await store.resolveWithdrawal(match[1], match[2], String(body.note || "").slice(0, 200)));
					return true;
				}
			} catch (error) {
				console.error("Admin error:", error.message);
				json(response, 500, { ok: false });
				return true;
			}
			json(response, 404, { ok: false });
			return true;
		}
		return false;
	}

	return { enabled, handle, http, onChatEnd, onPrivateText, dropFromQueues };
}
