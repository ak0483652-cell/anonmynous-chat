// Audio call signaling (WebRTC). Server sirf "setup messages" pass karta hai, awaaz seedha users ke browser ke beech jaati hai.
// Rules: sirf one-to-one chat, dono Gmail se sign-in, dono ki consent (request -> accept), auto-connect nahi.
import { randomUUID } from "node:crypto";

const RING_MS = 30 * 1000;                 // itni der mein accept na ho to call khatam
const MAX_SIGNAL_CHARS = 6000;             // ek signaling message ki max size
const SIGNAL_KINDS = new Set(["offer", "answer", "ice"]);
const REQUEST_GAP_MS = 15 * 1000;          // do call request ke beech kam se kam gap
const REQUEST_WINDOW_MS = 10 * 60 * 1000;
const REQUEST_MAX_IN_WINDOW = 6;

// STUN free hai. TURN (jo ~10-20% users ko chahiye) Render Environment se aata hai:
// TURN_URLS="turn:example.com:3478,turns:example.com:5349", TURN_USERNAME, TURN_CREDENTIAL
function buildIceServers() {
	const servers = [{ urls: ["stun:stun.l.google.com:19302"] }];
	const urls = (process.env.TURN_URLS || "").split(",").map((value) => value.trim()).filter(Boolean);
	if (urls.length > 0 && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
		servers.push({ urls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
	}
	return servers;
}

export function createCallSignaling({ send, clients }) {
	const calls = new Map(); // callId -> call

	function otherSide(call, socket) {
		return call.caller === socket ? call.callee : call.caller;
	}

	function endCall(call, reason) {
		if (!calls.delete(call.id)) return;
		clearTimeout(call.timer);
		for (const side of [call.caller, call.callee]) {
			if (side.call === call) side.call = null;
			send(side, { type: "call-ended", callId: call.id, reason });
		}
	}

	// Call tabhi sahi hai jab dono ab bhi usi one-to-one chat mein hon.
	function isLive(socket, call) {
		return Boolean(call) && calls.get(call.id) === call && Boolean(socket.peer) && socket.peer === otherSide(call, socket) && socket.matchId === call.matchId;
	}

	function fail(socket, message) {
		send(socket, { type: "call-error", message });
	}

	function handleRequest(socket) {
		const peer = socket.peer;
		if (!socket.profile) return fail(socket, "Set up your profile first.");
		if (socket.ai || !peer || !socket.matchId) return fail(socket, "Calls are only available in a one-to-one chat with a real person.");
		if (!socket.uid) return fail(socket, "Sign in with Gmail to use calls.");
		if (!peer.uid) return fail(socket, "Your chat partner has not signed in with Gmail, so calls are not available.");
		if (socket.call || peer.call) return fail(socket, "A call is already in progress.");

		const now = Date.now();
		socket.callRequestTimes = (socket.callRequestTimes || []).filter((at) => now - at < REQUEST_WINDOW_MS);
		const last = socket.callRequestTimes[socket.callRequestTimes.length - 1] || 0;
		if (now - last < REQUEST_GAP_MS) return fail(socket, "Please wait a few seconds before calling again.");
		if (socket.callRequestTimes.length >= REQUEST_MAX_IN_WINDOW) return fail(socket, "Too many call requests. Please try again later.");
		socket.callRequestTimes.push(now);

		const call = { id: randomUUID(), caller: socket, callee: peer, matchId: socket.matchId, state: "ringing", timer: null, signalTimes: [] };
		call.timer = setTimeout(() => endCall(call, "no-answer"), RING_MS);
		calls.set(call.id, call);
		socket.call = call;
		peer.call = call;
		send(socket, { type: "call-ringing", callId: call.id });
		send(peer, { type: "call-incoming", callId: call.id });
	}

	function handleAccept(socket, payload) {
		const call = socket.call;
		if (!call || payload.callId !== call.id || call.callee !== socket || call.state !== "ringing" || !isLive(socket, call)) return;
		clearTimeout(call.timer);
		call.state = "active";
		const iceServers = buildIceServers();
		send(call.caller, { type: "call-accepted", callId: call.id, role: "caller", iceServers });
		send(call.callee, { type: "call-accepted", callId: call.id, role: "callee", iceServers });
	}

	function handleSignal(socket, payload) {
		const call = socket.call;
		if (!call || payload.callId !== call.id || call.state !== "active" || !isLive(socket, call)) return;
		if (!SIGNAL_KINDS.has(payload.kind) || !payload.data || typeof payload.data !== "object") return;
		if (JSON.stringify(payload.data).length > MAX_SIGNAL_CHARS) return;
		const now = Date.now();
		call.signalTimes = call.signalTimes.filter((at) => now - at < 10 * 1000);
		if (call.signalTimes.length >= 80) return;
		call.signalTimes.push(now);
		send(otherSide(call, socket), { type: "call-signal", callId: call.id, kind: payload.kind, data: payload.data });
	}

	// Returns true agar message "call-" wala tha (handle ho gaya).
	function handle(socket, payload) {
		if (typeof payload.type !== "string" || !payload.type.startsWith("call-")) return false;
		switch (payload.type) {
			case "call-request":
				handleRequest(socket);
				break;
			case "call-accept":
				handleAccept(socket, payload);
				break;
			case "call-decline":
				if (socket.call && payload.callId === socket.call.id && socket.call.callee === socket && socket.call.state === "ringing") endCall(socket.call, "declined");
				break;
			case "call-cancel":
				if (socket.call && payload.callId === socket.call.id && socket.call.caller === socket && socket.call.state === "ringing") endCall(socket.call, "cancelled");
				break;
			case "call-signal":
				handleSignal(socket, payload);
				break;
			case "call-end":
				if (socket.call && payload.callId === socket.call.id) endCall(socket.call, "ended");
				break;
			default:
				break;
		}
		return true;
	}

	// Private chat khatam (next, report, partner left, disconnect, ban): call bhi turant khatam.
	function onChatEnded(socket) {
		if (socket.call) endCall(socket.call, "chat-ended");
	}

	return { handle, onChatEnded };
}
