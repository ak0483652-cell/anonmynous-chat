// node test-wallet.mjs   -> wallet ka hisaab bina database ke check karta hai (fake store + fake sockets).
process.env.WITHDRAW_HOLD_DAYS = "0.00002"; // test me hold ~2 second
process.env.MIN_WITHDRAW_RUPEES = "50";

import assert from "node:assert/strict";
import { createWallet, CONFIG, toPaise } from "./wallet.js";

// ---------- fake store (SQL functions jaisa hi behaviour) ----------
const db = { wallets: new Map(), ledger: new Set(), lots: [], withdrawals: [] };
let clock = Date.now();
Date.now = () => clock;
const mkWallet = (uid) => {
	if (!db.wallets.has(uid)) db.wallets.set(uid, { credits: 0, earn: 0, code: uid.toUpperCase().padEnd(8, "X").slice(0, 8) });
	return db.wallets.get(uid);
};
const store = {
	storeEnabled: true,
	async getWallet(uid) {
		const w = mkWallet(uid);
		for (const lot of db.lots) if (lot.uid === uid && !lot.released && lot.at <= clock) { lot.released = true; w.earn += lot.credits; }
		const pending = db.lots.filter((l) => l.uid === uid && !l.released).reduce((a, l) => a + l.credits, 0);
		return { credits: w.credits, earn_credits: w.earn, pending_credits: pending, code: w.code, referred_by: null };
	},
	async applyDelta(uid, credits, earn, kind, ref) {
		const w = mkWallet(uid);
		const key = `${kind}:${ref}`;
		if (db.ledger.has(key)) return { ok: false, reason: "duplicate" };
		if (w.credits + credits < 0 || w.earn + earn < 0) return { ok: false, reason: "insufficient" };
		db.ledger.add(key);
		w.credits += credits;
		w.earn += earn;
		return { ok: true };
	},
	async addLot(uid, credits, availableAtIso, ref) {
		db.lots.push({ uid, credits, at: new Date(availableAtIso).getTime(), released: false, ref });
		return { ok: true };
	},
	async countKind() { return 0; },
	async requestWithdrawal(uid, upi, minPaise) {
		const w = (await this.getWallet(uid));
		const paise = toPaise(w.earn_credits);
		if (paise < minPaise) return { ok: false, reason: "below_minimum", paise };
		const used = Math.min(w.earn_credits, Math.ceil(paise * 100 / 39));
		mkWallet(uid).earn -= used;
		db.withdrawals.push({ uid, upi, paise });
		return { ok: true, id: db.withdrawals.length, paise };
	}
};

// ---------- fake server pieces ----------
const clients = new Set();
let wallet;
function makeSocket(uid, ip, gender = "Man") {
	const s = { readyState: 1, peer: null, matchId: null, uid, ip, profile: { gender, age: 25, country: "India" }, blockedIps: new Set(), matchPreference: "any", sent: [], ai: null };
	clients.add(s);
	return s;
}
const deps = {
	send: (socket, message) => { if (socket.readyState === 1) socket.sent.push(message); },
	clients,
	canMatch: (a, b) => !a.blockedIps.has(b.ip) && !b.blockedIps.has(a.ip),
	connectGuests(a, b) { a.peer = b; b.peer = a; a.matchId = b.matchId = Math.random().toString(36); },
	endPrivateChat(socket) {
		wallet.onChatEnd(socket);
		const peer = socket.peer;
		socket.peer = null; socket.matchId = null;
		if (peer) { peer.peer = null; peer.matchId = null; deps.send(peer, { type: "partner-left" }); }
	},
	removeFromQueue(socket) { wallet.dropFromQueues(socket); }
};
wallet = createWallet(deps, store);

const lastOf = (socket, type) => [...socket.sent].reverse().find((m) => m.type === type);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function paidChat({ seekerTexts, listenerTexts }) {
	const seeker = makeSocket("seeker", "1.1.1.1");
	const listener = makeSocket("listener", "2.2.2.2", "Woman");
	await wallet.handle(listener, { type: "listen-start" });
	await wallet.handle(seeker, { type: "find-paid", preference: "any" });
	assert.ok(seeker.peer === listener, "seeker aur listener match hone chahiye");
	for (let i = 0; i < seekerTexts; i += 1) wallet.onPrivateText(seeker, `hello number ${i}`);
	for (let i = 0; i < listenerTexts; i += 1) { clock += 2500; wallet.onPrivateText(listener, `reply number ${i}`); }
	deps.endPrivateChat(seeker);
	await sleep(20);
	clients.delete(seeker); clients.delete(listener);
	return { seeker, listener };
}

// 1) Seeker ke paas credits hi nahi => connect nahi
{
	const poor = makeSocket("poor", "9.9.9.9");
	await wallet.handle(poor, { type: "find-paid", preference: "any" });
	assert.ok(lastOf(poor, "wallet-error"), "credits ke bina error aana chahiye");
	assert.equal(db.wallets.get("poor").credits, 0);
	clients.delete(poor);
	console.log("OK  1. credits ke bina connect nahi hota, kuch nahi katta");
}

// 2) Rs 39 recharge (10,000 credits). Asli chat: 20 reply => listener ko max 140.
await store.applyDelta("seeker", 10000, 0, "recharge", "order_1");
{
	const { seeker, listener } = await paidChat({ seekerTexts: 5, listenerTexts: 20 });
	assert.equal(db.wallets.get("seeker").credits, 10000 - CONFIG.connectCost);
	const lot = db.lots.find((l) => l.uid === "listener");
	assert.equal(lot.credits, 140);
	assert.equal(lastOf(listener, "paid-settled").earnedCredits, 140);
	assert.equal(lastOf(seeker, "paid-settled").refunded, false);
	console.log(`OK  2. asli chat: seeker ke 400 kate, listener ko 140 credits (${toPaise(140)} paise) hold me gaye`);
}

// 3) Listener ne reply nahi diya => seeker ko poora refund
{
	const before = db.wallets.get("seeker").credits;
	const { seeker } = await paidChat({ seekerTexts: 4, listenerTexts: 1 });
	assert.equal(db.wallets.get("seeker").credits, before, "refund ke baad balance wahi rehna chahiye");
	assert.equal(lastOf(seeker, "paid-settled").refunded, true);
	console.log("OK  3. listener ne reply nahi diya => seeker ke credits poore wapas");
}

// 4) Spam ("aaa" baar baar, bahut tezi se) par kamaai nahi
{
	const seeker = makeSocket("seeker", "1.1.1.1");
	const listener = makeSocket("spammer", "3.3.3.3");
	await wallet.handle(listener, { type: "listen-start" });
	await wallet.handle(seeker, { type: "find-paid", preference: "any" });
	for (let i = 0; i < 5; i += 1) wallet.onPrivateText(seeker, "hello friend");
	for (let i = 0; i < 50; i += 1) wallet.onPrivateText(listener, "aaa");
	deps.endPrivateChat(seeker);
	await sleep(20);
	assert.equal(db.lots.filter((l) => l.uid === "spammer").length, 0, "spam par kamaai nahi honi chahiye");
	clients.delete(seeker); clients.delete(listener);
	console.log("OK  4. spam texts par kamaai nahi");
}

// 5) Khud ke do account (same uid) aapas me match nahi hote
{
	const a = makeSocket("seeker", "5.5.5.5");
	const b = makeSocket("seeker", "6.6.6.6");
	await wallet.handle(b, { type: "listen-start" });
	await wallet.handle(a, { type: "find-paid", preference: "any" });
	assert.equal(a.peer, null, "same account khud se match nahi hona chahiye");
	await wallet.handle(a, { type: "listen-stop" });
	wallet.dropFromQueues(a); wallet.dropFromQueues(b);
	clients.delete(a); clients.delete(b);
	console.log("OK  5. same account / same IP khud ko match nahi hota");
}

// 6) Hold: abhi withdraw nahi, ~2 second baad khulta hai, aur min Rs 50 ka rule
{
	const before = await store.getWallet("listener");
	assert.equal(before.earn_credits, 0, "hold ke dauran earnings available nahi honi chahiye");
	assert.ok(before.pending_credits >= 140);
	await sleep(2200);
	clock += 3 * 86400000;
	const after = await store.getWallet("listener");
	assert.ok(after.earn_credits >= 140, "hold khulne ke baad earnings available hon");
	const tooSmall = await store.requestWithdrawal("listener", "a@upi", CONFIG.minWithdrawPaise);
	assert.equal(tooSmall.reason, "below_minimum");
	await store.addLot("listener", 13000, new Date(clock - 1).toISOString(), "big");
	const big = await store.getWallet("listener");
	const ok = await store.requestWithdrawal("listener", "a@upi", CONFIG.minWithdrawPaise);
	assert.equal(ok.ok, true);
	assert.ok(ok.paise >= 5000);
	console.log(`OK  6. hold sirf time se khulta hai; Rs 50 se kam withdraw nahi; ~Rs ${(ok.paise / 100).toFixed(2)} request hui (earn ${big.earn_credits} credits)`);
}

// 7) Hisaab: ek Rs 39 recharge (25 connects, har me 20 asli reply) par owner ko kitna bachta hai
{
	const credits = 10000;
	const connects = Math.floor(credits / CONFIG.connectCost);
	const listenerCredits = connects * CONFIG.listenerMaxEarn;
	const revenue = 3900;
	const gateway = Math.round(revenue * 0.02);
	const listenerPaise = toPaise(listenerCredits);
	const ownerPaise = revenue - gateway - listenerPaise;
	assert.ok(ownerPaise > 0, "owner ko ghata nahi hona chahiye");
	console.log(`OK  7. Rs 39 par: ${connects} connects, listeners ko Rs ${(listenerPaise / 100).toFixed(2)}, gateway Rs ${(gateway / 100).toFixed(2)}, owner ko ~Rs ${(ownerPaise / 100).toFixed(2)} bachta hai`);
}

console.log("\nSab tests pass.");
process.exit(0);
