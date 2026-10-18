const modeButtons = document.querySelectorAll(".mode-button");
const messageList = document.querySelector("#message-list");
const messageForm = document.querySelector("#message-form");
const messageInput = document.querySelector("#message-input");
const charCount = document.querySelector("#char-count");
const guestNameElement = document.querySelector("#guest-name");
const guestAvatar = document.querySelector("#guest-avatar");
const emptyState = document.querySelector("#empty-state");
const matchState = document.querySelector("#match-state");
const composerHint = document.querySelector("#composer-hint");
const serviceStatus = document.querySelector("#service-status");
const activeCount = document.querySelector("#active-count");
const profileDialog = document.querySelector("#profile-dialog");
const profileForm = document.querySelector("#profile-form");
const matchPreference = document.querySelector("#match-preference");
const publicMessages = [];
const privateMessages = [];
let activeMode = "room";
let privateState = "idle";
let peerName = "";
let peerUserId = "";
let peerProfile = null;
let profile = readSessionProfile();
let profileReady = false;
let verified = false;
let banned = false;
let aiEnabled = false;
let peerIsAi = false;
const blockedUserIds = new Set();
let guestName = `Guest-${Math.floor(100 + Math.random() * 900)}`;
let socket;
let reconnectTimer;
let toastTimer;

document.querySelector("#profile-country").value = "India";

function getTurnstileToken() {
	try {
		return window.turnstile ? window.turnstile.getResponse() || "" : "";
	} catch {
		return "";
	}
}

function resetTurnstile() {
	try {
		if (window.turnstile) window.turnstile.reset();
	} catch {
		// ignore
	}
}

function openProfileDialog() {
	if (profile) {
		document.querySelector("#profile-gender").value = profile.gender;
		document.querySelector("#profile-age").value = profile.age;
		document.querySelector("#profile-country").value = profile.country;
	}
	if (!profileDialog.open) profileDialog.showModal();
}

function readSessionProfile() {
	try {
		const saved = JSON.parse(sessionStorage.getItem("strangely-profile") || "null");
		if (saved && typeof saved.gender === "string" && Number.isInteger(saved.age) && saved.age >= 18 && saved.country === "India") return saved;
	} catch {
		return null;
	}
	return null;
}

function formatGenderLabel(gender) {
	if (gender === "Man") return "Male";
	if (gender === "Woman") return "Female";
	return gender || "";
}

function profileLabel(value) {
	if (!value) return "";
	return `${formatGenderLabel(value.gender)} · ${value.age} · ${value.country}`;
}

function updateProfileSummary() {
	document.querySelector("#profile-summary").textContent = profile ? profileLabel(profile) : "Profile not set";
	if (guestNameElement) {
		guestNameElement.textContent = profile ? formatGenderLabel(profile.gender) : guestName;
	}
	if (guestAvatar) {
		guestAvatar.textContent = profile ? (profile.gender === "Woman" ? "F" : profile.gender === "Man" ? "M" : "G") : guestName.slice(-1).toUpperCase();
	}
}

function showToast(message) {
	const toast = document.querySelector("#toast");
	toast.textContent = message;
	toast.classList.add("visible");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => toast.classList.remove("visible"), 3000);
}

function sendToServer(message) {
	if (message.type !== "set-profile" && !profileReady) {
		showToast("Set up your profile before chatting.");
		openProfileDialog();
		return false;
	}
	if (!socket || socket.readyState !== WebSocket.OPEN) {
		showToast("Not connected to the server. Please try again.");
		return false;
	}
	socket.send(JSON.stringify(message));
	return true;
}

function renderMessage(message, isPrivate) {
	const item = document.createElement("article");
	const isMine = message.name === guestName;
	item.className = `message${isMine ? " mine" : ""}`;

	const avatar = document.createElement("div");
	avatar.className = `avatar ${isMine ? "avatar-you" : "avatar-chat"}`;
	avatar.textContent = isMine ? "ME" : message.ai ? "AI" : message.name.slice(-2).toUpperCase();
	if (message.ai) item.classList.add("ai-message");
	avatar.setAttribute("aria-hidden", "true");

	const body = document.createElement("div");
	body.className = "message-body";
	const meta = document.createElement("div");
	meta.className = "message-meta";
	const name = document.createElement("span");
	name.className = "message-name";
	name.textContent = message.name;
	const time = document.createElement("time");
	time.className = "message-time";
	time.textContent = new Date(message.sentAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
	meta.append(name, time);
	const senderProfile = document.createElement("span");
	senderProfile.className = "message-profile";
	senderProfile.textContent = profileLabel(message.profile);
	if (senderProfile.textContent) meta.append(senderProfile);
	if (!isMine && !isPrivate && message.userId) {
		const reportButton = document.createElement("button");
		reportButton.type = "button";
		reportButton.className = "report-link";
		reportButton.textContent = "Report";
		reportButton.title = "Report and block this person";
		reportButton.addEventListener("click", () => {
			if (!window.confirm(`Report ${message.name} and hide their messages?`)) return;
			sendToServer({ type: "report", scope: "public", userId: message.userId });
		});
		meta.append(reportButton);
	}

	const text = document.createElement("p");
	text.className = "message-text";
	text.textContent = message.text;
	body.append(meta, text);
	item.append(avatar, body);
	messageList.append(item);
	if (!isPrivate) emptyState.hidden = true;
}

function showMode(mode) {
	activeMode = mode;
	const isRoom = mode === "room";
	document.querySelector("#room-title").textContent = isRoom ? "Public room" : "One-to-one";
	document.querySelector("#room-description").textContent = isRoom
		? "Open chat for everyone."
		: privateState === "matched" ? `Private chat with ${peerName}` : "Private chat with a random guest.";
	document.querySelector("#room-mark").textContent = isRoom ? "◉" : "↗";
	document.querySelector("#empty-title").textContent = "No messages yet.";
	document.querySelector("#empty-copy").textContent = isRoom
		? "Messages in the public room are visible to everyone connected."
		: "Choose who you would like to chat with. Gender is self-reported and not verified.";
	modeButtons.forEach((button) => {
		const isActive = button.dataset.mode === mode;
		button.classList.toggle("active", isActive);
		button.setAttribute("aria-current", isActive ? "page" : "false");
	});
	const isMatched = privateState === "matched";
	matchPreference.disabled = privateState !== "idle";
	messageForm.hidden = !isRoom && !isMatched;
	messageInput.placeholder = isMatched ? "Write a private message..." : "Write a message...";
	messageList.hidden = !isRoom && !isMatched;
	emptyState.hidden = !isRoom || publicMessages.length > 0;
	matchState.hidden = isRoom || isMatched;
	document.querySelector("#private-greeting").hidden = !isMatched;
	document.querySelector("#next-chat").hidden = !isMatched;
	document.querySelector("#leave-chat").hidden = !isMatched;
	document.querySelector("#report-chat").hidden = !isMatched || peerIsAi;
	document.querySelector("#ai-offer").hidden = !aiEnabled;
	document.querySelector("#ai-badge").hidden = !(isMatched && peerIsAi);
	if (isRoom) {
		messageList.replaceChildren();
		publicMessages.filter((message) => !blockedUserIds.has(message.userId)).forEach((message) => renderMessage(message, false));
		composerHint.textContent = "Everyone in the public room can see this message.";
	} else if (isMatched) {
		messageList.replaceChildren();
		privateMessages.forEach((message) => renderMessage(message, true));
		composerHint.textContent = peerIsAi ? "You are talking to an AI, not a real person." : "This private chat is visible only to you and your match.";
	} else {
		composerHint.textContent = "Find a match to start a private chat.";
	}
}

function fitTextarea() {
	messageInput.style.height = "auto";
	messageInput.style.height = `${Math.min(messageInput.scrollHeight, 130)}px`;
}

guestNameElement.textContent = guestName;
guestAvatar.textContent = guestName.slice(-1);
updateProfileSummary();
showMode(activeMode);
if (!profile) profileDialog.showModal();

function handleBanned(text) {
	banned = true;
	clearTimeout(reconnectTimer);
	serviceStatus.textContent = "BANNED";
	serviceStatus.dataset.state = "offline";
	composerHint.textContent = text || "You are banned after reports from other users. Please try again later.";
	messageInput.disabled = true;
	messageForm.hidden = false;
	if (profileDialog.open) profileDialog.close();
	showToast(composerHint.textContent);
}

function connect() {
	const configuredSocketUrl = window.STRANGELY_WS_URL?.trim() || "";
	if (configuredSocketUrl.includes("YOUR-RENDER-SERVICE")) {
		serviceStatus.textContent = "SET SERVER URL";
		serviceStatus.dataset.state = "offline";
		composerHint.textContent = "Add the Render WebSocket URL to config.js before publishing.";
		return;
	}
	if (!window.location.host || !["http:", "https:"].includes(window.location.protocol)) {
		serviceStatus.textContent = "SERVER REQUIRED";
		serviceStatus.dataset.state = "offline";
		composerHint.textContent = "Start the server to use chat.";
		return;
	}

	serviceStatus.textContent = "CONNECTING...";
	serviceStatus.dataset.state = "connecting";
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	socket = new WebSocket(configuredSocketUrl || `${protocol}//${window.location.host}/ws`);

	socket.addEventListener("open", () => {
		clearTimeout(reconnectTimer);
	});
	socket.addEventListener("message", (event) => {
		let message;
		try {
			message = JSON.parse(event.data);
		} catch {
			return;
		}

		if (message.type === "active-count") {
			const count = Number.isInteger(message.count) && message.count >= 0 ? message.count : 0;
			activeCount.textContent = `${count} active`;
		} else if (message.type === "ready") {
			guestName = message.guestName;
			aiEnabled = Boolean(message.aiEnabled);
			document.querySelector("#ai-offer").hidden = !aiEnabled;
			guestNameElement.textContent = guestName;
			guestAvatar.textContent = guestName.slice(-1);
			serviceStatus.textContent = "LIVE";
			serviceStatus.dataset.state = "live";
			if (profile) {
				// Saved profile hai: Turnstile token mil jaye to seedha bhejo, warna dialog kholo.
				const token = getTurnstileToken();
				if (token) {
					sendToServer({ type: "set-profile", profile, turnstileToken: token });
					resetTurnstile();
				} else {
					openProfileDialog();
				}
			} else {
				profileDialog.showModal();
			}
		} else if (message.type === "profile-saved") {
			profile = message.profile;
			profileReady = true;
			verified = true;
			sessionStorage.setItem("strangely-profile", JSON.stringify(profile));
			updateProfileSummary();
			composerHint.textContent = activeMode === "room" ? "Everyone in the public room can see this message." : "Find a match to start a private chat.";
		} else if (message.type === "verify-failed") {
			verified = false;
			profileReady = false;
			resetTurnstile();
			showToast(message.message || "Verification failed. Please try again.");
			openProfileDialog();
		} else if (message.type === "public-history") {
			publicMessages.splice(0, publicMessages.length, ...message.messages);
			if (activeMode === "room") showMode("room");
		} else if (message.type === "public-message") {
			publicMessages.push(message);
			if (publicMessages.length > 100) publicMessages.shift();
			if (activeMode === "room" && !blockedUserIds.has(message.userId)) {
				renderMessage(message, false);
				document.querySelector("#conversation").scrollTop = document.querySelector("#conversation").scrollHeight;
			}
		} else if (message.type === "queued") {
			privateState = "waiting";
			matchPreference.disabled = true;
			matchState.classList.add("is-waiting");
			document.querySelector("#match-title").textContent = "Looking for a partner...";
			document.querySelector("#match-copy").textContent = "Waiting for another guest to join.";
			document.querySelector("#find-match").hidden = true;
			document.querySelector("#cancel-match").hidden = false;
			serviceStatus.textContent = "SEARCHING...";
			serviceStatus.dataset.state = "searching";
			showMode("private");
		} else if (message.type === "matched") {
			privateState = "matched";
			peerIsAi = false;
			matchPreference.disabled = true;
			peerName = message.peerName;
			peerUserId = message.peerUserId;
			peerProfile = message.peerProfile;
			matchState.classList.remove("is-waiting");
			privateMessages.length = 0;
			document.querySelector("#private-greeting").textContent = `You: ${profileLabel(profile)} | ${message.peerName}: ${profileLabel(peerProfile)}`;
			document.querySelector("#private-greeting").hidden = false;
			document.querySelector("#match-title").textContent = "Find someone to chat with privately.";
			document.querySelector("#match-copy").textContent = "Choose who you would like to chat with. Gender is self-reported and not verified.";
			document.querySelector("#find-match").hidden = false;
			document.querySelector("#cancel-match").hidden = true;
			serviceStatus.textContent = "PRIVATE CHAT";
			serviceStatus.dataset.state = "live";
			showMode("private");
		} else if (message.type === "profile-updated" && message.peerUserId === peerUserId) {
			peerProfile = message.peerProfile;
			document.querySelector("#private-greeting").textContent = `You: ${profileLabel(profile)} | ${message.peerName}: ${profileLabel(peerProfile)}`;
		} else if (message.type === "private-message") {
			privateMessages.push(message);
			if (activeMode === "private" && privateState === "matched") {
				renderMessage(message, true);
				document.querySelector("#conversation").scrollTop = document.querySelector("#conversation").scrollHeight;
			}
		} else if (["partner-left", "private-left", "match-cancelled"].includes(message.type)) {
			privateState = "idle";
			peerIsAi = false;
			matchPreference.disabled = false;
			peerName = "";
			matchState.classList.remove("is-waiting");
			privateMessages.length = 0;
			document.querySelector("#match-title").textContent = message.type === "partner-left" ? "Chat ended." : "Find someone to chat with privately.";
			document.querySelector("#match-copy").textContent = message.type === "partner-left" ? "The other guest left. You can find another partner." : "Choose who you would like to chat with. Gender is self-reported and not verified.";
			document.querySelector("#find-match").hidden = false;
			document.querySelector("#cancel-match").hidden = true;
			serviceStatus.textContent = "LIVE";
			serviceStatus.dataset.state = "live";
			if (activeMode === "private") showMode("private");
		} else if (message.type === "ai-matched") {
			privateState = "matched";
			peerIsAi = true;
			matchPreference.disabled = true;
			peerName = message.name || "AI";
			peerUserId = "aisha-ai";
			peerProfile = null;
			matchState.classList.remove("is-waiting");
			privateMessages.length = 0;
			document.querySelector("#private-greeting").textContent = message.auto
				? 'You were matched with an AI, not a real person. Tap "Next chat" to find a real person.'
				: "You are chatting with an AI, not a real person.";
			if (message.auto) showToast("You are chatting with an AI, not a real person. Tap Next chat to find a real person.");
			document.querySelector("#private-greeting").hidden = false;
			document.querySelector("#match-title").textContent = "Find someone to chat with privately.";
			document.querySelector("#match-copy").textContent = "Choose who you would like to chat with. Gender is self-reported and not verified.";
			document.querySelector("#find-match").hidden = false;
			document.querySelector("#cancel-match").hidden = true;
			serviceStatus.textContent = "AI CHAT";
			serviceStatus.dataset.state = "live";
			showMode("private");
		} else if (message.type === "ai-typing") {
			if (activeMode === "private" && peerIsAi) composerHint.textContent = message.on ? "AI is typing..." : "You are talking to an AI, not a real person.";
		} else if (message.type === "report-received") {
			if (message.scope === "public" && message.userId) {
				blockedUserIds.add(message.userId);
				if (activeMode === "room") showMode("room");
			}
			showToast("Reported and blocked. Thank you for keeping Strangely safe.");
		} else if (message.type === "banned") {
			handleBanned(message.message);
		} else if (message.type === "error") {
			showToast(message.message);
		}
	});
	socket.addEventListener("close", (event) => {
		if (event.code === 4003) handleBanned();
		if (banned) return;
		serviceStatus.textContent = "RECONNECTING...";
		serviceStatus.dataset.state = "offline";
		privateState = "idle";
		profileReady = false;
		verified = false;
		if (activeMode === "private") showMode("private");
		reconnectTimer = setTimeout(connect, 2000);
	});
	socket.addEventListener("error", () => socket.close());
}

connect();

document.querySelector("#edit-profile").addEventListener("click", () => {
	openProfileDialog();
});

profileForm.addEventListener("submit", (event) => {
	event.preventDefault();
	if (!profileForm.reportValidity()) return;

	// Is connection par verify nahi hua hai to Turnstile token zaroori hai.
	const token = getTurnstileToken();
	if (!verified && !token) {
		showToast("Please complete the verification first.");
		return;
	}

	profile = {
		gender: document.querySelector("#profile-gender").value,
		age: Number(document.querySelector("#profile-age").value),
		country: document.querySelector("#profile-country").value
	};
	profileReady = false;
	sessionStorage.setItem("strangely-profile", JSON.stringify(profile));
	updateProfileSummary();
	profileDialog.close();
	sendToServer({ type: "set-profile", profile, turnstileToken: token });
	if (token) resetTurnstile();
});

modeButtons.forEach((button) => {
	button.addEventListener("click", () => {
		if (button.dataset.mode === "room" && activeMode === "private") {
			if (privateState === "waiting") sendToServer({ type: "cancel-match" });
			if (privateState === "matched") sendToServer({ type: "leave-private" });
			privateState = "idle";
		}
		showMode(button.dataset.mode);
	});
});

messageInput.addEventListener("input", () => {
	charCount.textContent = `${messageInput.value.length} / 600`;
	fitTextarea();
});

messageInput.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		messageForm.requestSubmit();
	}
});

messageForm.addEventListener("submit", (event) => {
	event.preventDefault();
	const text = messageInput.value.trim();
	if (!text) return;

	const type = activeMode === "room" ? "public-message" : "private-message";
	if (!sendToServer({ type, text })) return;
	messageInput.value = "";
	charCount.textContent = "0 / 600";
	fitTextarea();
	messageInput.focus();
});

document.querySelector("#find-match").addEventListener("click", () => {
	if (sendToServer({ type: "find-partner", preference: matchPreference.value })) {
		privateState = "waiting";
		matchPreference.disabled = true;
		document.querySelector("#match-title").textContent = "Looking for a partner...";
		document.querySelector("#match-copy").textContent = "Waiting for another guest to join.";
		document.querySelector("#find-match").hidden = true;
		document.querySelector("#cancel-match").hidden = false;
	}
});

document.querySelector("#cancel-match").addEventListener("click", () => sendToServer({ type: "cancel-match" }));
document.querySelector("#start-ai").addEventListener("click", () => sendToServer({ type: "start-ai" }));
document.querySelector("#next-chat").addEventListener("click", () => {
	if (sendToServer({ type: "next-partner", preference: matchPreference.value })) {
		privateState = "waiting";
		matchPreference.disabled = true;
		privateMessages.length = 0;
		document.querySelector("#match-title").textContent = "Looking for another partner...";
		document.querySelector("#match-copy").textContent = "Waiting for another guest to join.";
		document.querySelector("#find-match").hidden = true;
		document.querySelector("#cancel-match").hidden = false;
		showMode("private");
	}
});
document.querySelector("#report-chat").addEventListener("click", () => {
	if (!window.confirm("Report this person and end the chat? You will not be matched with them again.")) return;
	sendToServer({ type: "report", scope: "private" });
});
document.querySelector("#leave-chat").addEventListener("click", () => {
	sendToServer({ type: "leave-private" });
	privateState = "idle";
	showMode("private");
});
document.querySelector("#back-to-room").addEventListener("click", () => {
	if (privateState === "waiting") sendToServer({ type: "cancel-match" });
	privateState = "idle";
	showMode("room");
});

// ---------- Screenshot deterrents (best effort, browser mein pakka rokna mumkin nahi) ----------
// Window se focus hatne par chat blur ho jata hai. Pasand na aaye to false kar do.
const PROTECT_ON_BLUR = true;
const conversationArea = document.querySelector("#conversation");
let shieldTimer;

function setPrivacyShield(on) {
	document.body.classList.toggle("privacy-shield", on);
}

function flashPrivacyShield() {
	setPrivacyShield(true);
	clearTimeout(shieldTimer);
	shieldTimer = setTimeout(() => setPrivacyShield(PROTECT_ON_BLUR && !document.hasFocus()), 1500);
}

document.addEventListener("keydown", (event) => {
	const key = String(event.key || "").toLowerCase();
	const windowsSnip = event.metaKey && event.shiftKey && key === "s";
	const macShot = event.metaKey && event.shiftKey && ["3", "4", "5", "#", "$", "%"].includes(key);
	if (windowsSnip || macShot) flashPrivacyShield();
});

document.addEventListener("keyup", (event) => {
	if (event.key === "PrintScreen") {
		flashPrivacyShield();
		try {
			navigator.clipboard.writeText(" ");
		} catch {
			// ignore
		}
		showToast("Screenshots are not allowed on Strangely.");
	}
});

window.addEventListener("blur", () => {
	if (PROTECT_ON_BLUR) setPrivacyShield(true);
});
window.addEventListener("focus", () => setPrivacyShield(false));
document.addEventListener("visibilitychange", () => {
	if (document.hidden) setPrivacyShield(true);
	else setPrivacyShield(PROTECT_ON_BLUR && !document.hasFocus());
});

["contextmenu", "copy", "cut", "dragstart"].forEach((name) => {
	conversationArea.addEventListener(name, (event) => event.preventDefault());
});
