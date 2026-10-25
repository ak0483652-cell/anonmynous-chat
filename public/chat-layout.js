// Knot-style layout: hamburger drawer, partner card, composer mein Leave button.
// script.js mein koi badlav nahi chahiye (uske globals sirf padhta hai).
(function () {
	"use strict";
	var $ = function (s) { return document.querySelector(s); };
	var header = $(".chat-header"), sidebar = $(".sidebar"), conv = $("#conversation");
	var form = $("#message-form"), leaveChat = $("#leave-chat"), list = $("#message-list");
	if (!header || !sidebar || !conv || !form || !list) return;

	// ---- drawer ----
	var menu = document.createElement("button");
	menu.type = "button";
	menu.className = "cx-menu";
	menu.setAttribute("aria-label", "Open menu");
	menu.setAttribute("aria-expanded", "false");
	menu.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10"/></svg>';
	header.insertBefore(menu, header.firstChild);
	var scrim = document.createElement("div");
	scrim.className = "cx-scrim";
	document.body.appendChild(scrim);
	function setDrawer(open) {
		document.body.classList.toggle("cx-drawer-open", open);
		menu.setAttribute("aria-expanded", open ? "true" : "false");
	}
	menu.addEventListener("click", function () { setDrawer(!document.body.classList.contains("cx-drawer-open")); });
	scrim.addEventListener("click", function () { setDrawer(false); });
	sidebar.addEventListener("click", function (e) { if (e.target.closest("button, a")) setDrawer(false); });
	document.addEventListener("keydown", function (e) { if (e.key === "Escape") setDrawer(false); });

	// ---- Leave button (message box ke paas) ----
	var leave = document.createElement("button");
	leave.type = "button";
	leave.className = "cx-leave";
	leave.textContent = "Leave";
	leave.title = "End this chat";
	leave.hidden = true;
	leave.addEventListener("click", function () { if (leaveChat) leaveChat.click(); });
	form.appendChild(leave);

	// ---- partner card ----
	var ICON = {
		male: '<circle cx="10" cy="14" r="5"/><path d="M14 10l6-6M15 4h5v5"/>',
		female: '<circle cx="12" cy="9" r="5"/><path d="M12 14v7M9 18h6"/>',
		other: '<circle cx="12" cy="12" r="6"/>',
		ai: '<rect x="5" y="8" width="14" height="10" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/>',
		age: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
		globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>'
	};
	function svg(name) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[name] + "</svg>"; }
	function genderLabel(g) { return g === "Man" ? "Male" : g === "Woman" ? "Female" : g || ""; }
	function genderIcon(g) { return g === "Man" ? "male" : g === "Woman" ? "female" : "other"; }
	function meta(parent, icon, text) {
		if (!text) return;
		var s = document.createElement("span");
		s.insertAdjacentHTML("beforeend", svg(icon));
		s.appendChild(document.createTextNode(text));
		parent.appendChild(s);
	}

	// script.js ke top-level variables (let) yahan se padh sakte hain.
	function readState() {
		try { return { mode: activeMode, state: privateState, ai: peerIsAi, name: peerName, prof: peerProfile }; } catch (e) { return null; }
	}

	function render() {
		var s = readState();
		var live = Boolean(s) && s.mode === "private" && s.state === "matched";
		leave.hidden = !live;
		var card = $("#cx-peer");
		document.body.classList.toggle("cx-real-peer", live && !s.ai);
		if (!live) { if (card) card.hidden = true; return; }
		if (!card) {
			card = document.createElement("section");
			card.id = "cx-peer";
			card.className = "cx-peer";
			conv.insertBefore(card, list);
		}
		card.hidden = false;
		card.classList.toggle("is-ai", Boolean(s.ai));
		card.replaceChildren();

		var top = document.createElement("div");
		top.className = "cx-peer-top";
		var av = document.createElement("div");
		av.className = "cx-peer-av";
		av.innerHTML = svg(s.ai ? "ai" : genderIcon(s.prof && s.prof.gender));
		var info = document.createElement("div");
		var name = document.createElement("p");
		name.className = "cx-peer-name";
		name.textContent = s.name || "Stranger";
		var status = document.createElement("p");
		status.className = "cx-peer-status";
		status.textContent = s.ai ? "AI · not a real person" : "Connected";
		info.append(name, status);
		top.append(av, info);
		card.appendChild(top);

		if (!s.ai && s.prof) {
			var m = document.createElement("p");
			m.className = "cx-peer-meta";
			meta(m, genderIcon(s.prof.gender), genderLabel(s.prof.gender));
			meta(m, "age", s.prof.age ? String(s.prof.age) : "");
			meta(m, "globe", s.prof.country);
			card.appendChild(m);
		}
	}

	var timer;
	var observer = new MutationObserver(function () { clearTimeout(timer); timer = setTimeout(render, 0); });
	["#private-greeting", "#service-status", "#room-title", "#leave-chat", "#match-state"].forEach(function (sel) {
		var node = $(sel);
		if (node) observer.observe(node, { attributes: true, childList: true, characterData: true, subtree: true });
	});
	render();
})();

// ---------- Reply to message (tap Reply / phone par message ko right swipe) ----------
// script.js ke renderMessage aur sendToServer ko lapetta hai. Server (server.js) replyTo ka snapshot banakar sabko bhejta hai.
(function () {
	"use strict";
	var form = document.getElementById("message-form");
	var list = document.getElementById("message-list");
	var input = document.getElementById("message-input");
	if (!form || !list || !input) return;
	var reply = null;

	// Composer ke upar "Replying to ..." bar
	var bar = document.createElement("div");
	bar.className = "cx-replybar";
	bar.hidden = true;
	var body = document.createElement("div");
	body.className = "cx-replybar-body";
	var barName = document.createElement("strong");
	var barText = document.createElement("span");
	body.append(barName, barText);
	var close = document.createElement("button");
	close.type = "button";
	close.setAttribute("aria-label", "Cancel reply");
	close.textContent = "×";
	close.addEventListener("click", function () { setReply(null); });
	bar.append(body, close);
	form.insertBefore(bar, form.firstChild);

	function setReply(r) {
		reply = r;
		if (!r) { bar.hidden = true; return; }
		barName.textContent = "Replying to " + r.who;
		barText.textContent = r.text;
		bar.hidden = false;
		input.focus();
	}

	function myId() { try { return currentUserId; } catch (e) { return ""; } }
	function toast(text) { if (typeof window.showToast === "function") window.showToast(text); }

	function startReply(item, message) {
		if (!message || !message.messageId) { toast("This older message cannot be replied to."); return; }
		var mine = item.classList.contains("mine");
		setReply({ id: message.messageId, who: mine ? "yourself" : (message.name || "Guest"), text: String(message.text || "").slice(0, 120) });
	}

	function jumpTo(id) {
		var safe = window.CSS && CSS.escape ? CSS.escape(id) : id;
		var node = list.querySelector('[data-message-id="' + safe + '"]');
		if (!node) { toast("Original message is no longer available."); return; }
		node.scrollIntoView({ block: "center", behavior: "smooth" });
		node.classList.remove("cx-flash");
		void node.offsetWidth;
		node.classList.add("cx-flash");
	}

	function decorate(item, message) {
		if (!item || item.__cx || !message) return;
		item.__cx = message;
		var text = item.querySelector(".message-text");
		var meta = item.querySelector(".message-meta");
		if (message.replyTo && text) {
			var r = message.replyTo;
			var q = document.createElement("button");
			q.type = "button";
			q.className = "cx-quote";
			var qn = document.createElement("strong");
			qn.textContent = r.userId && r.userId === myId() ? "You" : (r.name || "Guest");
			var qt = document.createElement("span");
			qt.textContent = r.text || "";
			q.append(qn, qt);
			q.addEventListener("click", function () { jumpTo(r.messageId); });
			text.parentNode.insertBefore(q, text);
		}
		if (meta && message.messageId) {
			var btn = document.createElement("button");
			btn.type = "button";
			btn.className = "cx-reply-btn";
			btn.textContent = "Reply";
			btn.title = "Reply to this message";
			btn.addEventListener("click", function () { startReply(item, message); });
			meta.append(btn);
		}
	}

	if (typeof window.renderMessage === "function") {
		var origRender = window.renderMessage;
		window.renderMessage = function (message) {
			var result = origRender.apply(this, arguments);
			try { decorate(list.lastElementChild, message); } catch (e) { /* ignore */ }
			return result;
		};
	}

	// Send karte waqt replyTo jodo; bhej diya to bar hata do
	if (typeof window.sendToServer === "function") {
		var origSend = window.sendToServer;
		window.sendToServer = function (msg) {
			if (reply && msg && (msg.type === "public-message" || msg.type === "private-message")) {
				msg.replyTo = reply.id;
				var ok = origSend.apply(this, arguments);
				if (ok) setReply(null);
				return ok;
			}
			return origSend.apply(this, arguments);
		};
	}

	// Mode ya chat badle to purana reply hata do
	var clearObserver = new MutationObserver(function () { if (reply) setReply(null); });
	["#room-title", "#service-status"].forEach(function (sel) {
		var node = document.querySelector(sel);
		if (node) clearObserver.observe(node, { childList: true, characterData: true, subtree: true });
	});

	// Phone: message ko right swipe karo to reply
	var startX = 0, startY = 0, target = null, dx = 0, swiping = false;
	list.addEventListener("touchstart", function (e) {
		var item = e.target.closest(".message");
		if (!item || e.touches.length !== 1) return;
		target = item; startX = e.touches[0].clientX; startY = e.touches[0].clientY; dx = 0; swiping = false;
	}, { passive: true });
	list.addEventListener("touchmove", function (e) {
		if (!target) return;
		var t = e.touches[0], mx = t.clientX - startX, my = t.clientY - startY;
		if (!swiping) {
			if (Math.abs(my) > 12 && Math.abs(my) > Math.abs(mx)) { target = null; return; }
			if (mx > 10 && Math.abs(mx) > Math.abs(my)) swiping = true; else return;
		}
		dx = Math.max(0, Math.min(mx, 80));
		target.style.transition = "none";
		target.style.transform = "translateX(" + dx + "px)";
	}, { passive: true });
	function endSwipe() {
		if (!target) return;
		var item = target;
		target = null;
		item.style.transition = "transform .2s ease";
		item.style.transform = "";
		if (swiping && dx >= 55 && item.__cx) startReply(item, item.__cx);
		swiping = false; dx = 0;
		setTimeout(function () { item.style.transition = ""; }, 220);
	}
	list.addEventListener("touchend", endSwipe);
	list.addEventListener("touchcancel", endSwipe);
})();
