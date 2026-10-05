import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

const publicDirectory = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 3000);
const clients = new Set();
const waitingGuests = [];
const publicHistory = [];
const publicHistoryClearMs = Number.isFinite(Number(process.env.PUBLIC_HISTORY_CLEAR_MS)) && Number(process.env.PUBLIC_HISTORY_CLEAR_MS) > 0
	? Number(process.env.PUBLIC_HISTORY_CLEAR_MS)
	: 3 * 60 * 1000;
const contentTypes = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8"
};

function send(socket, message) {
	if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

// Cloudflare Turnstile token ko server par verify karta hai.
// Secret Key sirf Render ke Environment variable TURNSTILE_SECRET mein rehti hai.
async function verifyTurnstile(token) {
	const secret = process.env.TURNSTILE_SECRET;
	if (!secret) {
		console.error("TURNSTILE_SECRET is not set on the server.");
		return false;
	}
	try {
		const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ secret, response: token })
		});
		const result = await response.json();
		return result.success === true;
	} catch (error) {
		console.error("Turnstile verification request failed:", error);
		return false;
	}
}

function broadcastActiveCount() {
	const message = { type: "active-count", count: clients.size };
	for (const client of clients) send(client, message);
}

function clearPublicHistory() {
	if (publicHistory.length === 0) return;
	publicHistory.length = 0;
	for (const client of clients) send(client, { type: "public-history", messages: [] });
}

function removeFromQueue(socket) {
	const index = waitingGuests.indexOf(socket);
	if (index !== -1) waitingGuests.splice(index, 1);
}

function acceptsGender(socket, gender) {
	return socket.matchPreference !== "women" || gender === "Woman";
}

function canMatch(first, second) {
	if (first.blockedIps.has(second.ip) || second.blockedIps.has(first.ip)) return false;
	return first.profile && second.profile && acceptsGender(first, second.profile.gender) && acceptsGender(second, first.profile.gender);
}

function connectGuests(first, second) {
	const matchId = randomUUID();
	first.peer = second;
	second.peer = first;
	first.matchId = matchId;
	second.matchId = matchId;
	send(first, { type: "matched", peerName: second.guestName, peerUserId: second.userId, peerProfile: second.profile });
	send(second, { type: "matched", peerName: first.guestName, peerUserId: first.userId, peerProfile: first.profile });
}

function queueGuest(socket) {
	if (!socket.profile) {
		send(socket, { type: "error", message: "Set up your profile before chatting." });
		return;
	}
	removeFromQueue(socket);
	for (let index = waitingGuests.length - 1; index >= 0; index -= 1) {
		const candidate = waitingGuests[index];
		if (candidate.readyState !== WebSocket.OPEN || candidate.peer) waitingGuests.splice(index, 1);
	}
	const matchIndex = waitingGuests.findIndex((candidate) => candidate !== socket && canMatch(socket, candidate));
	if (matchIndex !== -1) {
		const other = waitingGuests.splice(matchIndex, 1)[0];
		connectGuests(socket, other);
		return;
	}

	waitingGuests.push(socket);
	send(socket, { type: "queued", position: waitingGuests.length });
}

function endPrivateChat(socket) {
	const peer = socket.peer;
	socket.peer = null;
	socket.matchId = null;
	if (!peer) return;
	peer.peer = null;
	peer.matchId = null;
	send(peer, { type: "partner-left" });
}

// ---------- Report / Block / Ban ----------
// Kitne alag-alag logon (alag IP) ke report par ban lagega. Render ke Environment mein REPORT_THRESHOLD se badal sakte ho.
const REPORT_THRESHOLD = Number(process.env.REPORT_THRESHOLD) > 0 ? Number(process.env.REPORT_THRESHOLD) : 3;
const REPORT_WINDOW_MS = 30 * 60 * 1000;
// Pehla ban 1 ghanta, doosra 24 ghante, teesra aur uske baad 7 din.
const BAN_STEPS_MS = [60 * 60 * 1000, 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000];
// Render jaise proxy ke peeche asli IP X-Forwarded-For mein proxy se theek pehle hota hai.
// (Pehli entry koi bhi fake kar sakta hai, isliye wo use nahi karte.)
const PROXY_HOPS = Number.isInteger(Number(process.env.PROXY_HOPS)) && Number(process.env.PROXY_HOPS) >= 0 ? Number(process.env.PROXY_HOPS) : 1;
const bans = new Map(); // ip -> { until, count }
const reportsAgainst = new Map(); // ip -> Map(reporterIp -> time)
const recentUsers = new Map(); // userId -> { ip, seenAt } (jo abhi disconnect hue)

function getClientIp(request) {
	const forwarded = String(request.headers["x-forwarded-for"] || "").split(",").map((part) => part.trim()).filter(Boolean);
	if (forwarded.length > 0) return forwarded[Math.max(0, forwarded.length - 1 - PROXY_HOPS)];
	return request.socket.remoteAddress || "unknown";
}

function getActiveBan(ip) {
	const entry = bans.get(ip);
	return entry && entry.until > Date.now() ? entry : null;
}

function describeDuration(ms) {
	const minutes = Math.max(1, Math.ceil(ms / 60000));
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
	const hours = Math.ceil(minutes / 60);
	if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
	return `${Math.ceil(hours / 24)} days`;
}

function sendBanned(socket, entry) {
	send(socket, { type: "banned", until: entry.until, message: `You are banned for ${describeDuration(entry.until - Date.now())} after reports from other users.` });
	socket.close(4003, "banned");
}

function banIp(ip) {
	const previous = bans.get(ip);
	const count = previous ? previous.count : 0;
	const entry = { until: Date.now() + BAN_STEPS_MS[Math.min(count, BAN_STEPS_MS.length - 1)], count: count + 1 };
	bans.set(ip, entry);
	reportsAgainst.delete(ip);
	for (const client of [...clients]) {
		if (client.ip === ip) sendBanned(client, entry);
	}
	console.log(`A user was banned (offence #${entry.count}).`);
}

function findUserIp(userId) {
	for (const client of clients) {
		if (client.userId === userId) return client.ip;
	}
	const recent = recentUsers.get(userId);
	return recent ? recent.ip : null;
}

function handleReport(socket, payload) {
	const now = Date.now();
	socket.reportTimes = socket.reportTimes.filter((at) => now - at < 10 * 60 * 1000);
	if (socket.reportTimes.length >= 5) {
		send(socket, { type: "error", message: "Too many reports. Please try again later." });
		return;
	}

	let target = null;
	if (payload.scope === "private") {
		if (!socket.peer) return;
		target = { userId: socket.peer.userId, ip: socket.peer.ip };
	} else if (payload.scope === "public") {
		const userId = typeof payload.userId === "string" ? payload.userId : "";
		// Sirf unhi ko report kar sakte ho jinka message public room mein abhi dikh raha hai.
		if (!userId || userId === socket.userId || !publicHistory.some((message) => message.userId === userId)) {
			send(socket, { type: "error", message: "Could not report that message." });
			return;
		}
		target = { userId, ip: findUserIp(userId) };
	} else {
		return;
	}

	socket.reportTimes.push(now);
	if (target.ip && target.ip !== socket.ip) {
		// Block: ye banda is user ko dobara match nahi hoga aur uske public message nahi dikhenge.
		socket.blockedIps.add(target.ip);
		// Report: alag-alag IP se REPORT_THRESHOLD reports aane par ban.
		const reporters = reportsAgainst.get(target.ip) || new Map();
		for (const [reporterIp, at] of reporters) {
			if (now - at > REPORT_WINDOW_MS) reporters.delete(reporterIp);
		}
		reporters.set(socket.ip, now);
		reportsAgainst.set(target.ip, reporters);
		if (reporters.size >= REPORT_THRESHOLD) banIp(target.ip);
	}

	if (payload.scope === "private") {
		endPrivateChat(socket);
		send(socket, { type: "private-left" });
	}
	send(socket, { type: "report-received", scope: payload.scope, userId: target.userId });
}

function pruneModerationData() {
	const now = Date.now();
	for (const [userId, info] of recentUsers) {
		if (now - info.seenAt > 15 * 60 * 1000) recentUsers.delete(userId);
	}
	for (const [ip, reporters] of reportsAgainst) {
		for (const [reporterIp, at] of reporters) {
			if (now - at > REPORT_WINDOW_MS) reporters.delete(reporterIp);
		}
		if (reporters.size === 0) reportsAgainst.delete(ip);
	}
	for (const [ip, entry] of bans) {
		if (now - entry.until > 7 * 24 * 60 * 60 * 1000) bans.delete(ip);
	}
}
// ---------- End report / block / ban ----------

async function handleMessage(socket, payload) {
	if (!payload || typeof payload !== "object" || typeof payload.type !== "string") return;

	if (payload.type === "set-profile") {
		const profile = payload.profile;
		const genders = ["Woman", "Man", "Non-binary", "Prefer not to say"];
		if (!profile || !genders.includes(profile.gender) || !Number.isInteger(profile.age) || profile.age < 18 || profile.age > 99 || profile.country !== "India") {
			send(socket, { type: "error", message: "Select a valid gender, age 18 or older, and India as your country." });
			return;
		}

		// Is connection par pehli baar profile set ho rahi hai to Turnstile verify zaroori hai.
		if (!socket.verified) {
			const token = payload.turnstileToken;
			if (typeof token !== "string" || !token || token.length > 2048) {
				send(socket, { type: "verify-failed", message: "Please complete the verification." });
				return;
			}
			if (socket.verifying) return;
			socket.verifying = true;
			const ok = await verifyTurnstile(token);
			socket.verifying = false;
			if (!ok) {
				send(socket, { type: "verify-failed", message: "Verification failed. Please try again." });
				return;
			}
			socket.verified = true;
		}

		socket.profile = { gender: profile.gender, age: profile.age, country: profile.country.trim() };
		send(socket, { type: "profile-saved", profile: socket.profile });
		if (socket.peer) {
			send(socket.peer, { type: "profile-updated", peerName: socket.guestName, peerUserId: socket.userId, peerProfile: socket.profile });
		}
		return;
	}

	if (payload.type === "public-message" || payload.type === "private-message") {
		if (!socket.profile) {
			send(socket, { type: "error", message: "Set up your profile before chatting." });
			return;
		}
		if (typeof payload.text !== "string") return;
		const text = payload.text.trim().slice(0, 600);
		if (!text) return;
		const now = Date.now();
		socket.messageTimes = socket.messageTimes.filter((sentAt) => now - sentAt < 5000);
		if (socket.messageTimes.length >= 8) {
			send(socket, { type: "error", message: "Please wait a moment before sending another message." });
			return;
		}
		socket.messageTimes.push(now);
		const message = {
			type: payload.type === "public-message" ? "public-message" : "private-message",
			userId: socket.userId,
			name: socket.guestName,
			profile: socket.profile,
			text,
			sentAt: Date.now()
		};

		if (payload.type === "public-message") {
			publicHistory.push(message);
			if (publicHistory.length > 100) publicHistory.shift();
			for (const client of clients) {
				if (!client.blockedIps.has(socket.ip)) send(client, message);
			}
		} else if (socket.peer && socket.matchId) {
			send(socket.peer, message);
			send(socket, message);
		}
		return;
	}

	if (payload.type === "report") {
		if (!socket.profile) {
			send(socket, { type: "error", message: "Set up your profile before chatting." });
			return;
		}
		handleReport(socket, payload);
		return;
	}

	if (payload.type === "find-partner") {
		if (!socket.profile) {
			send(socket, { type: "error", message: "Set up your profile before chatting." });
			return;
		}
		if (payload.preference !== "any" && payload.preference !== "women") {
			send(socket, { type: "error", message: "Choose a valid match preference." });
			return;
		}
		socket.matchPreference = payload.preference;
		if (!socket.peer) queueGuest(socket);
		return;
	}

	if (payload.type === "cancel-match") {
		removeFromQueue(socket);
		if (socket.peer) endPrivateChat(socket);
		send(socket, { type: "match-cancelled" });
		return;
	}

	if (payload.type === "next-partner") {
		if (payload.preference === "any" || payload.preference === "women") socket.matchPreference = payload.preference;
		endPrivateChat(socket);
		queueGuest(socket);
		return;
	}

	if (payload.type === "leave-private") {
		removeFromQueue(socket);
		endPrivateChat(socket);
		send(socket, { type: "private-left" });
	}
}

const server = createServer(async (request, response) => {
	const pathname = new URL(request.url, "http://localhost").pathname;
	if (pathname === "/health") {
		response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
		response.end(JSON.stringify({ status: "ok", online: clients.size }));
		return;
	}

	const fileName = pathname === "/" ? "index.html" : pathname.slice(1);
	if (!["index.html", "script.js", "style.css", "config.js"].includes(fileName)) {
		response.writeHead(404);
		response.end("Not found");
		return;
	}

	try {
		const content = await readFile(join(publicDirectory, fileName));
		response.writeHead(200, { "content-type": contentTypes[extname(fileName)] });
		response.end(content);
	} catch {
		response.writeHead(500);
		response.end("Unable to load page");
	}
});

// maxPayload 4096: Turnstile token 2048 characters tak ka ho sakta hai.
const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 4096 });
server.on("upgrade", (request, socket, head) => {
	if (new URL(request.url, "http://localhost").pathname !== "/ws") {
		socket.destroy();
		return;
	}
	webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
		webSocketServer.emit("connection", webSocket, request);
	});
});

webSocketServer.on("connection", (socket, request) => {
	socket.ip = getClientIp(request);
	const activeBan = getActiveBan(socket.ip);
	if (activeBan) {
		sendBanned(socket, activeBan);
		return;
	}
	socket.blockedIps = new Set();
	socket.reportTimes = [];
	socket.userId = randomUUID();
	socket.guestName = `Guest-${Math.floor(100 + Math.random() * 900)}`;
	socket.peer = null;
	socket.matchId = null;
	socket.profile = null;
	socket.verified = false;
	socket.verifying = false;
	socket.matchPreference = "any";
	socket.messageTimes = [];
	clients.add(socket);
	send(socket, { type: "ready", guestName: socket.guestName });
	send(socket, { type: "public-history", messages: publicHistory });
	broadcastActiveCount();

	socket.on("message", async (data) => {
		try {
			await handleMessage(socket, JSON.parse(data.toString()));
		} catch {
			send(socket, { type: "error", message: "Could not read that message." });
		}
	});

	socket.on("close", () => {
		recentUsers.set(socket.userId, { ip: socket.ip, seenAt: Date.now() });
		clients.delete(socket);
		removeFromQueue(socket);
		endPrivateChat(socket);
		broadcastActiveCount();
	});
});

setInterval(clearPublicHistory, publicHistoryClearMs);
setInterval(pruneModerationData, 5 * 60 * 1000);

server.listen(port, "0.0.0.0", () => {
	console.log(`Strangely is running at http://localhost:${port}`);
});
