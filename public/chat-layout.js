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
