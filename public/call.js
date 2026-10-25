// Strangely audio call (client). Sirf awaaz, video nahi. Apna UI khud banata hai.
// Use: StrangelyCall.init({ mount: ".composer-controls", send: (obj) => socket.send(JSON.stringify(obj)) });
//      websocket ke har aane wale message par: StrangelyCall.onMessage(msg);
(function () {
	"use strict";

	var state = {
		send: null,
		signedIn: false,
		inChat: false,
		peerGmail: false,
		call: null // { id, role, phase, pc, stream, pending:[], muted, startedAt, timer, connTimer, dropTimer }
	};
	var ui = {};
	var MIC = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false };
	var CONNECT_TIMEOUT_MS = 25000; // itni der mein connect na ho to call fail
	var DROP_GRACE_MS = 20000;      // network blip par itni der wait, phir fail
	var REASONS = {
		declined: "Call declined.",
		cancelled: "Call cancelled.",
		"no-answer": "No answer.",
		ended: "Call ended.",
		"chat-ended": "Call ended.",
		failed: "Call could not connect. Check your network and try again."
	};

	function css() {
		var s = document.createElement("style");
		s.textContent =
			".sc-btn{position:fixed;bottom:calc(env(safe-area-inset-bottom,0px) + 150px);right:max(12px,env(safe-area-inset-right,0px));z-index:9998;border:0;border-radius:999px;width:44px;height:44px;padding:0;display:inline-flex;align-items:center;justify-content:center;background:#3b6df0;color:#fff;font:700 20px system-ui,sans-serif;box-shadow:0 6px 18px rgba(59,109,240,.35);cursor:pointer;-webkit-tap-highlight-color:transparent}" +
			".sc-btn[hidden],.sc-bar[hidden],.sc-in[hidden]{display:none!important}" +
			".sc-btn.sc-dim{background:#8d97b5;box-shadow:none}" +
			".sc-btn.sc-inline{position:static;width:38px;height:38px;font-size:18px;box-shadow:none;flex:0 0 auto;margin-right:4px}" +
			".sc-btn:active{transform:scale(.94)}" +
			".sc-bar{position:fixed;top:max(8px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);z-index:9999;display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:center;background:#16203a;color:#fff;padding:10px 14px;border-radius:18px;box-shadow:0 10px 30px rgba(0,0,0,.35);font:600 14px system-ui,sans-serif;max-width:calc(100% - 16px);animation:sc-pop .18s ease-out}" +
			".sc-bar button,.sc-in button{border:0;border-radius:12px;padding:10px 16px;font:700 14px system-ui,sans-serif;cursor:pointer;color:#fff;-webkit-tap-highlight-color:transparent}" +
			".sc-mute{background:#3b6df0}.sc-mute.on{background:#b45309}.sc-end{background:#d92d20}.sc-rep{background:#475069}" +
			".sc-in{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.55);animation:sc-fade .18s ease-out}" +
			".sc-card{background:#fff;color:#1f2a44;border-radius:22px;padding:24px;width:min(320px,calc(100% - 32px));text-align:center;font:600 16px system-ui,sans-serif;box-shadow:0 20px 50px rgba(0,0,0,.3);animation:sc-pop .2s ease-out}" +
			".sc-card p{margin:0 0 16px}.sc-acc{background:#16a34a}.sc-dec{background:#d92d20}.sc-card button{margin:0 5px}" +
			".sc-toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:10001;background:#16203a;color:#fff;padding:10px 16px;border-radius:12px;font:600 14px system-ui,sans-serif;max-width:calc(100% - 32px);text-align:center}" +
			"@keyframes sc-pop{from{opacity:0;transform:translateX(-50%) scale(.95)}to{opacity:1;transform:translateX(-50%) scale(1)}}" +
			".sc-card{animation-name:sc-card-pop}@keyframes sc-card-pop{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:scale(1)}}" +
			"@keyframes sc-fade{from{opacity:0}to{opacity:1}}";
		document.head.appendChild(s);
	}

	function el(tag, cls, text) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text) e.textContent = text;
		return e;
	}

	function build(mount) {
		css();
		ui.btn = el("button", "sc-btn", "📞");
		ui.btn.type = "button";
		ui.btn.hidden = true;
		ui.btn.setAttribute("aria-label", "Start audio call");
		ui.btn.title = "Audio call";
		ui.btn.addEventListener("click", onCallClick);
		var host = mount ? (typeof mount === "string" ? document.querySelector(mount) : mount) : null;
		if (host) {
			ui.btn.className = "sc-btn sc-inline";
			host.insertBefore(ui.btn, host.firstChild);
		} else {
			document.body.appendChild(ui.btn);
		}

		ui.bar = el("div", "sc-bar");
		ui.bar.hidden = true;
		ui.status = el("span", "", "");
		ui.mute = el("button", "sc-mute", "Mute");
		ui.end = el("button", "sc-end", "End");
		ui.rep = el("button", "sc-rep", "Report");
		ui.mute.type = ui.end.type = ui.rep.type = "button";
		ui.mute.addEventListener("click", toggleMute);
		ui.end.addEventListener("click", function () { hangup(true); });
		ui.rep.addEventListener("click", onReport);
		ui.bar.append(ui.status, ui.mute, ui.end, ui.rep);
		document.body.appendChild(ui.bar);

		ui.incoming = el("div", "sc-in");
		ui.incoming.hidden = true;
		var card = el("div", "sc-card");
		card.append(el("p", "", "Your chat partner wants to start an audio call."));
		ui.acc = el("button", "sc-acc", "Accept");
		ui.dec = el("button", "sc-dec", "Decline");
		ui.acc.type = ui.dec.type = "button";
		ui.acc.addEventListener("click", onAccept);
		ui.dec.addEventListener("click", function () { hangup(true); });
		card.append(ui.acc, ui.dec);
		ui.incoming.appendChild(card);
		document.body.appendChild(ui.incoming);

		ui.audio = document.createElement("audio");
		ui.audio.autoplay = true;
		ui.audio.setAttribute("playsinline", "");
		document.body.appendChild(ui.audio);

		// Mobile par autoplay block ho jaye to agle tap par awaaz chalu kar do.
		document.addEventListener("click", function () {
			if (state.call && ui.audio.srcObject && ui.audio.paused) ui.audio.play().catch(function () {});
		}, true);
	}

	var toastTimer;
	function toast(text) {
		if (!text) return;
		var t = document.querySelector(".sc-toast") || el("div", "sc-toast");
		t.textContent = text;
		if (!t.parentNode) document.body.appendChild(t);
		clearTimeout(toastTimer);
		toastTimer = setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 4000);
	}

	function fmt(sec) {
		var m = Math.floor(sec / 60), s = sec % 60;
		return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
	}

	// ---- Ring tone + vibration (incoming / outgoing) ----
	var ring = { ctx: null, timer: null };
	function stopRing() {
		clearInterval(ring.timer);
		ring.timer = null;
		if (navigator.vibrate) { try { navigator.vibrate(0); } catch (e) {} }
		if (ring.ctx) { try { ring.ctx.close(); } catch (e) {} ring.ctx = null; }
	}
	function startRing(incoming) {
		stopRing();
		function beep() {
			try {
				if (!ring.ctx) {
					var AC = window.AudioContext || window.webkitAudioContext;
					if (!AC) return;
					ring.ctx = new AC();
				}
				var ctx = ring.ctx, o = ctx.createOscillator(), g = ctx.createGain();
				o.frequency.value = incoming ? 523 : 440;
				g.gain.setValueAtTime(0.0001, ctx.currentTime);
				g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.05);
				g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
				o.connect(g); g.connect(ctx.destination);
				o.start(); o.stop(ctx.currentTime + 0.65);
			} catch (e) {}
			if (incoming && navigator.vibrate) { try { navigator.vibrate([300, 150, 300]); } catch (e) {} }
		}
		beep();
		ring.timer = setInterval(beep, 2000);
	}

	// ---- Background call: screen off hone par bhi call chalti rahe ----
	// Screen ko ON rakhne ki jagah audio ko "media playback" jaisa mark karte hain,
	// taaki browser tab ko suspend na kare. (Android Chrome par kaam karta hai.)
	function keepAlive() {
		if (!("mediaSession" in navigator)) return;
		try {
			navigator.mediaSession.metadata = new MediaMetadata({ title: "Strangely audio call", artist: "On call" });
			navigator.mediaSession.playbackState = "playing";
			navigator.mediaSession.setActionHandler("hangup", function () { hangup(true); });
		} catch (e) {}
	}
	function releaseKeepAlive() {
		if (!("mediaSession" in navigator)) return;
		try {
			navigator.mediaSession.playbackState = "none";
			navigator.mediaSession.metadata = null;
			navigator.mediaSession.setActionHandler("hangup", null);
		} catch (e) {}
	}
	function lockScreen() { keepAlive(); }
	function unlockScreen() { releaseKeepAlive(); }
	// Screen wapas on ho: awaaz resume karo, UI timer refresh
	document.addEventListener("visibilitychange", function () {
		var c = state.call;
		if (document.visibilityState !== "visible" || !c) return;
		if (ui.audio.srcObject && ui.audio.paused) ui.audio.play().catch(function () {});
		if (c.phase === "active") { keepAlive(); render(); }
	});

	function render() {
		var c = state.call;
		ui.btn.hidden = !(state.signedIn && state.inChat && !c);
		ui.btn.classList.toggle("sc-dim", !state.peerGmail);
		ui.incoming.hidden = !(c && c.phase === "incoming");
		ui.bar.hidden = !(c && c.phase !== "incoming");
		if (!c) return;
		ui.mute.hidden = c.phase !== "active";
		ui.rep.hidden = c.phase === "outgoing";
		ui.mute.textContent = c.muted ? "Unmute" : "Mute";
		ui.mute.classList.toggle("on", c.muted);
		ui.end.textContent = c.phase === "outgoing" ? "Cancel" : "End";
		if (c.phase === "outgoing") ui.status.textContent = "Calling…";
		else if (c.phase === "connecting") ui.status.textContent = "Connecting…";
		else if (c.phase === "active") ui.status.textContent = (c.reconnecting ? "Reconnecting… " : "On call · ") + fmt(Math.floor((Date.now() - c.startedAt) / 1000));
	}

	function cleanup() {
		stopRing();
		unlockScreen();
		var c = state.call;
		if (!c) { render(); return; }
		clearInterval(c.timer);
		clearTimeout(c.connTimer);
		clearTimeout(c.dropTimer);
		if (c.pc) {
			c.pc.onicecandidate = c.pc.ontrack = c.pc.onconnectionstatechange = null;
			try { c.pc.close(); } catch (e) {}
		}
		if (c.stream) c.stream.getTracks().forEach(function (t) { t.stop(); });
		ui.audio.srcObject = null;
		state.call = null;
		render();
	}

	function hangup(notify) {
		var c = state.call;
		if (!c) return;
		if (notify && state.send) {
			if (c.phase === "outgoing") state.send({ type: "call-cancel", callId: c.id });
			else if (c.phase === "incoming") state.send({ type: "call-decline", callId: c.id });
			else state.send({ type: "call-end", callId: c.id });
		}
		cleanup();
	}

	function fail() {
		toast(REASONS.failed);
		hangup(true);
	}

	function getMic() {
		if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.RTCPeerConnection) {
			return Promise.reject(new Error("unsupported"));
		}
		return navigator.mediaDevices.getUserMedia(MIC);
	}

	function micError(err) {
		toast(err && err.message === "unsupported"
			? "Your browser does not support audio calls."
			: "Microphone permission is needed for calls. Allow it in your browser and try again.");
	}

	function onCallClick() {
		if (!state.peerGmail) { toast("Your partner must sign in with Gmail to take calls."); return; }
		if (state.call) return;
		getMic().then(function (stream) {
			if (state.call || !state.inChat) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
			state.call = { id: null, role: "caller", phase: "outgoing", stream: stream, pc: null, pending: [], muted: false, startedAt: 0, timer: null, connTimer: null, dropTimer: null };
			startRing(false);
			render();
			state.send({ type: "call-request" });
		}).catch(micError);
	}

	function onAccept() {
		var c = state.call;
		if (!c || c.phase !== "incoming") return;
		stopRing();
		getMic().then(function (stream) {
			if (state.call !== c) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
			c.stream = stream;
			c.phase = "connecting";
			render();
			state.send({ type: "call-accept", callId: c.id });
		}).catch(function (err) {
			micError(err);
			hangup(true);
		});
	}

	function toggleMute() {
		var c = state.call;
		if (!c || !c.stream) return;
		c.muted = !c.muted;
		c.stream.getAudioTracks().forEach(function (t) { t.enabled = !c.muted; });
		render();
	}

	function onReport() {
		if (!state.call) return;
		if (!window.confirm("Report this user and end the chat?")) return;
		state.send({ type: "report", scope: "private" });
		cleanup();
	}

	function markActive(c) {
		clearTimeout(c.connTimer);
		clearTimeout(c.dropTimer);
		c.reconnecting = false;
		if (c.phase !== "active") {
			c.phase = "active";
			c.startedAt = Date.now();
			c.timer = setInterval(render, 1000);
			stopRing();
			lockScreen();
		}
		render();
	}

	function startWebRtc(c, iceServers) {
		var pc = new RTCPeerConnection({ iceServers: iceServers || [{ urls: "stun:stun.l.google.com:19302" }] });
		c.pc = pc;
		c.stream.getTracks().forEach(function (t) { pc.addTrack(t, c.stream); });

		// Connect hone ki time limit
		c.connTimer = setTimeout(function () { if (state.call === c && c.phase !== "active") fail(); }, CONNECT_TIMEOUT_MS);

		pc.onicecandidate = function (e) {
			if (e.candidate && state.call === c) state.send({ type: "call-signal", callId: c.id, kind: "ice", data: e.candidate.toJSON() });
		};
		pc.ontrack = function (e) {
			ui.audio.srcObject = e.streams[0];
			var p = ui.audio.play();
			if (p && p.catch) p.catch(function () {});
		};
		pc.onconnectionstatechange = function () {
			if (state.call !== c) return;
			var s = pc.connectionState;
			if (s === "connected") {
				markActive(c);
			} else if (s === "disconnected") {
				// Network blip: thoda wait karo, caller ICE restart try kare
				if (c.phase === "active") { c.reconnecting = true; render(); }
				clearTimeout(c.dropTimer);
				c.dropTimer = setTimeout(function () { if (state.call === c && pc.connectionState !== "connected") fail(); }, DROP_GRACE_MS);
				if (c.role === "caller" && pc.restartIce) { try { pc.restartIce(); } catch (e) {} }
			} else if (s === "failed") {
				fail();
			}
		};
		if (c.role === "caller") {
			pc.onnegotiationneeded = null;
			pc.createOffer().then(function (offer) {
				return pc.setLocalDescription(offer);
			}).then(function () {
				state.send({ type: "call-signal", callId: c.id, kind: "offer", data: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
			}).catch(fail);
		}
		// Pehle aaye hue ICE candidates (agar pc banne se pehle aaye) ab lagao
		if (c.pending.length && pc.remoteDescription) flushPending(c);
	}

	function flushPending(c) {
		if (!c.pc) return;
		var list = c.pending.splice(0);
		list.forEach(function (cand) { c.pc.addIceCandidate(cand).catch(function () {}); });
	}

	function onSignal(m) {
		var c = state.call;
		if (!c || m.callId !== c.id) return;
		var pc = c.pc;
		// pc abhi bana nahi: ICE ko buffer karo, drop mat karo
		if (!pc) { if (m.kind === "ice") c.pending.push(m.data); return; }
		if (m.kind === "offer" && c.role === "callee") {
			pc.setRemoteDescription(m.data).then(function () {
				return pc.createAnswer();
			}).then(function (answer) {
				return pc.setLocalDescription(answer);
			}).then(function () {
				state.send({ type: "call-signal", callId: c.id, kind: "answer", data: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
				flushPending(c);
			}).catch(fail);
		} else if (m.kind === "answer" && c.role === "caller") {
			pc.setRemoteDescription(m.data).then(function () { flushPending(c); }).catch(fail);
		} else if (m.kind === "ice") {
			if (pc.remoteDescription) pc.addIceCandidate(m.data).catch(function () {});
			else c.pending.push(m.data);
		}
	}

	function onMessage(m) {
		if (!m || typeof m.type !== "string") return;
		switch (m.type) {
			case "ready":
				state.signedIn = false; state.inChat = false; state.peerGmail = false;
				cleanup();
				break;
			case "account-linked":
				if (m.ok) state.signedIn = true;
				break;
			case "profile-saved":
				if (m.gmail) state.signedIn = true;
				break;
			case "matched":
				cleanup();
				state.inChat = true;
				state.peerGmail = m.peerGmail === true;
				break;
			case "partner-left": case "private-left": case "ai-matched": case "queued": case "match-cancelled":
				state.inChat = false;
				state.peerGmail = false;
				cleanup();
				break;
			case "call-ringing":
				if (state.call && state.call.phase === "outgoing") state.call.id = m.callId;
				break;
			case "call-incoming":
				if (state.call) { state.send({ type: "call-decline", callId: m.callId }); break; }
				state.call = { id: m.callId, role: "callee", phase: "incoming", stream: null, pc: null, pending: [], muted: false, startedAt: 0, timer: null, connTimer: null, dropTimer: null };
				startRing(true);
				break;
			case "call-accepted":
				if (state.call && state.call.id === m.callId && state.call.stream) {
					stopRing();
					state.call.phase = "connecting";
					startWebRtc(state.call, m.iceServers);
				}
				break;
			case "call-signal":
				onSignal(m);
				return;
			case "call-ended":
				if (state.call && state.call.id === m.callId) {
					toast(REASONS[m.reason] || REASONS.ended);
					cleanup();
				}
				return;
			case "call-error":
				toast(m.message);
				if (state.call && state.call.phase === "outgoing" && !state.call.id) cleanup();
				return;
			default:
				return;
		}
		render();
	}

	window.StrangelyCall = {
		init: function (options) {
			options = options || {};
			state.send = options.send;
			if (!ui.btn) build(options.mount);
		},
		onMessage: onMessage
	};
})();
