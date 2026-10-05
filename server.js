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

function handleMessage(socket, payload) {
	if (!payload || typeof payload !== "object" || typeof payload.type !== "string") return;

	if (payload.type === "set-profile") {
		const profile = payload.profile;
		const genders = ["Woman", "Man", "Non-binary", "Prefer not to say"];
		if (!profile || !genders.includes(profile.gender) || !Number.isInteger(profile.age) || profile.age < 18 || profile.age > 99 || profile.country !== "India") {
			send(socket, { type: "error", message: "Select a valid gender, age 18 or older, and India as your country." });
			return;
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
			for (const client of clients) send(client, message);
		} else if (socket.peer && socket.matchId) {
			send(socket.peer, message);
			send(socket, message);
		}
		return;
	}

	if (payload.type === "find-partner") {
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

const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 2048 });
server.on("upgrade", (request, socket, head) => {
	if (new URL(request.url, "http://localhost").pathname !== "/ws") {
		socket.destroy();
		return;
	}
	webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
		webSocketServer.emit("connection", webSocket, request);
	});
});

webSocketServer.on("connection", (socket) => {
	socket.userId = randomUUID();
	socket.guestName = `Guest-${Math.floor(100 + Math.random() * 900)}`;
	socket.peer = null;
	socket.matchId = null;
	socket.profile = null;
	socket.matchPreference = "any";
	socket.messageTimes = [];
	clients.add(socket);
	send(socket, { type: "ready", guestName: socket.guestName });
	send(socket, { type: "public-history", messages: publicHistory });
	broadcastActiveCount();

	socket.on("message", (data) => {
		try {
			handleMessage(socket, JSON.parse(data.toString()));
		} catch {
			send(socket, { type: "error", message: "Could not read that message." });
		}
	});

	socket.on("close", () => {
		clients.delete(socket);
		removeFromQueue(socket);
		endPrivateChat(socket);
		broadcastActiveCount();
	});
});

setInterval(clearPublicHistory, publicHistoryClearMs);

server.listen(port, "0.0.0.0", () => {
	console.log(`Strangely is running at http://localhost:${port}`);
});
