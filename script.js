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
let guestName = `Guest-${Math.floor(100 + Math.random() * 900)}`;
let socket;
let reconnectTimer;
let toastTimer;

document.querySelector("#profile-country").value = "India";

function readSessionProfile() {
	try {
		const saved = JSON.parse(sessionStorage.getItem("strangely-profile") || "null");
		if (saved && typeof saved.gender === "string" && Number.isInteger(saved.age) && saved.age >= 18 && saved.country === "India") return saved;
	} catch {
		return null;
	}
	return null;
}

function profileLabel(value) {
	if (!value) return "";
	return `${value.gender} · ${value.age} · ${value.country}`;
}

function updateProfileSummary() {
	document.querySelector("#profile-summary").textContent = profile ? profileLabel(profile) : "Profile not set";
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
		profileDialog.showModal();
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
	avatar.textContent = isMine ? "ME" : message.name.slice(-2).toUpperCase();
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
	if (isRoom) {
		messageList.replaceChildren();
		publicMessages.forEach((message) => renderMessage(message, false));
		composerHint.textContent = "Everyone in the public room can see this message.";
	} else if (isMatched) {
		messageList.replaceChildren();
		privateMessages.forEach((message) => renderMessage(message, true));
		composerHint.textContent = "This private chat is visible only to you and your match.";
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
			guestNameElement.textContent = guestName;
			guestAvatar.textContent = guestName.slice(-1);
			serviceStatus.textContent = "LIVE";
			serviceStatus.dataset.state = "live";
			if (profile) sendToServer({ type: "set-profile", profile });
			else profileDialog.showModal();
		} else if (message.type === "profile-saved") {
			profile = message.profile;
			profileReady = true;
			sessionStorage.setItem("strangely-profile", JSON.stringify(profile));
			updateProfileSummary();
			composerHint.textContent = activeMode === "room" ? "Everyone in the public room can see this message." : "Find a match to start a private chat.";
		} else if (message.type === "public-history") {
			publicMessages.splice(0, publicMessages.length, ...message.messages);
			if (activeMode === "room") showMode("room");
		} else if (message.type === "public-message") {
			publicMessages.push(message);
			if (publicMessages.length > 100) publicMessages.shift();
			if (activeMode === "room") {
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
		} else if (message.type === "error") {
			showToast(message.message);
		}
	});
	socket.addEventListener("close", () => {
		serviceStatus.textContent = "RECONNECTING...";
		serviceStatus.dataset.state = "offline";
		privateState = "idle";
		profileReady = false;
		if (activeMode === "private") showMode("private");
		reconnectTimer = setTimeout(connect, 2000);
	});
	socket.addEventListener("error", () => socket.close());
}

connect();

document.querySelector("#edit-profile").addEventListener("click", () => {
	if (profile) {
		document.querySelector("#profile-gender").value = profile.gender;
		document.querySelector("#profile-age").value = profile.age;
		document.querySelector("#profile-country").value = profile.country;
	}
	profileDialog.showModal();
});

profileForm.addEventListener("submit", (event) => {
	event.preventDefault();
	if (!profileForm.reportValidity()) return;
	profile = {
		gender: document.querySelector("#profile-gender").value,
		age: Number(document.querySelector("#profile-age").value),
		country: document.querySelector("#profile-country").value
	};
	profileReady = false;
	sessionStorage.setItem("strangely-profile", JSON.stringify(profile));
	updateProfileSummary();
	profileDialog.close();
	sendToServer({ type: "set-profile", profile });
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
