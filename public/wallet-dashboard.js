// Strangely wallet dashboard (frontend). Koi library nahi chahiye.
// public/ folder me daalo aur index.html me <script src="wallet-dashboard.js"></script> jodo.
(() => {
	const state = { send: null, credits: null, referralCode: "", rules: null, history: [], signedIn: false, appUrl: location.origin, open: false, warnedLogin: false, disabled: false };
	const refs = {};

	// ?ref=CODE link se aaye to code yaad rakho (sign-in ke baad set-profile me jaata hai).
	try {
		const ref = new URLSearchParams(location.search).get("ref");
		if (ref && /^[\w-]{4,32}$/.test(ref)) localStorage.setItem("sw_ref", ref);
	} catch { /* storage band ho sakta hai */ }

	// script.js ko badalne ki zaroorat nahi: WebSocket ko hook karke messages sunta/bhejta hai.
	// Isliye ye file script.js se PEHLE load honi chahiye.
	const NativeWebSocket = window.WebSocket;
	if (NativeWebSocket && !NativeWebSocket.__swHooked) {
		class HookedWebSocket extends NativeWebSocket {
			constructor(...args) {
				super(...args);
				state.send = (obj) => { if (this.readyState === 1) NativeWebSocket.prototype.send.call(this, JSON.stringify(obj)); };
				this.addEventListener("message", (event) => {
					try { handle(JSON.parse(event.data)); } catch { /* binary ya non-JSON */ }
				});
			}
			send(data) {
				try {
					const message = typeof data === "string" ? JSON.parse(data) : null;
					if (message && message.type === "set-profile" && !message.ref) {
						const ref = localStorage.getItem("sw_ref");
						if (ref) data = JSON.stringify({ ...message, ref });
					}
				} catch { /* jaisa hai waisa bhejo */ }
				return super.send(data);
			}
		}
		HookedWebSocket.__swHooked = true;
		window.WebSocket = HookedWebSocket;
	}

	// Page me pehle se jo "Wallet" button hai, usi ko dashboard se jod dete hain.
	function findWalletButton() {
		const bound = document.querySelector("[data-sw-bound]");
		if (bound) return bound;
		const match = [...document.querySelectorAll("button, a, [role=button]")].find((node) => /^\s*wallet\s*$/i.test(node.textContent));
		if (match) match.setAttribute("data-sw-bound", "1");
		return match || null;
	}

	const css = `
.sw-chip{position:fixed;top:12px;right:12px;z-index:9999;display:none;align-items:center;gap:6px;padding:8px 14px;border:0;border-radius:999px;background:#1f2937;color:#fff;font:600 14px system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.25)}
.sw-chip.sw-show{display:inline-flex}
.sw-overlay{position:fixed;inset:0;z-index:10000;display:none;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.55)}
.sw-overlay.sw-show{display:flex}
.sw-card{width:100%;max-width:420px;max-height:90vh;overflow:auto;border-radius:18px;background:#fff;color:#111827;font:14px/1.45 system-ui,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.35)}
.sw-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 0}
.sw-head h2{margin:0;font-size:17px}
.sw-x{border:0;background:none;font-size:24px;line-height:1;cursor:pointer;color:#6b7280}
.sw-bal{margin:14px 18px;padding:18px;border-radius:14px;text-align:center;background:linear-gradient(135deg,#f59e0b,#ef4444);color:#fff}
.sw-bal b{display:block;font-size:40px;line-height:1.1}
.sw-bal span{font-size:13px;opacity:.9}
.sw-sec{padding:0 18px 14px}
.sw-sec h3{margin:6px 0;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280}
.sw-row{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid #f1f5f9}
.sw-row:last-child{border-bottom:0}
.sw-plus{color:#16a34a;font-weight:700;white-space:nowrap}
.sw-minus{color:#dc2626;font-weight:700;white-space:nowrap}
.sw-sub{display:block;font-size:12px;color:#9ca3af}
.sw-ref{display:flex;gap:6px}
.sw-ref input{flex:1;min-width:0;padding:8px 10px;border:1px solid #d1d5db;border-radius:8px;font-size:13px}
.sw-ref button{padding:8px 12px;border:0;border-radius:8px;background:#1f2937;color:#fff;font-weight:600;cursor:pointer}
.sw-msg{margin:0 18px 10px;padding:10px 12px;border-radius:10px;background:#fef3c7;color:#92400e;display:none}
.sw-msg.sw-show{display:block}
.sw-empty{color:#9ca3af;padding:8px 0}
.sw-toast{position:fixed;left:50%;bottom:24px;z-index:10001;transform:translateX(-50%);max-width:90vw;padding:10px 16px;border-radius:999px;background:#111827;color:#fff;font:600 14px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3)}
@media (prefers-color-scheme:dark){.sw-card{background:#1f2937;color:#f3f4f6}.sw-row{border-color:#374151}.sw-ref input{background:#111827;color:#f3f4f6;border-color:#4b5563}.sw-chip{background:#374151}.sw-ref button{background:#4b5563}}
`;

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	function label(reason) {
		if (reason.startsWith("reel:")) return "Watched a reel";
		if (reason === "chat-with-woman") return "Chat with a woman";
		if (reason === "referral-welcome") return "Welcome bonus (referral)";
		if (reason.startsWith("referral:")) return "Friend joined (referral bonus)";
		return reason;
	}

	function toast(text) {
		const node = el("div", "sw-toast", text);
		document.body.appendChild(node);
		setTimeout(() => node.remove(), 3200);
	}

	function render() {
		const credits = state.credits;
		const existing = findWalletButton();
		if (existing) {
			refs.chip.classList.remove("sw-show");
			existing.textContent = credits !== null && state.signedIn ? `Wallet · ${credits}` : "Wallet";
		} else {
			refs.chip.classList.add("sw-show");
			refs.chip.textContent = credits !== null && state.signedIn ? `🪙 ${credits}` : "🪙 Wallet";
		}
		// Guest (ya server se jawab na aaye) to 0 dikhao, "—" nahi.
		refs.balance.textContent = state.signedIn && credits !== null ? String(credits) : "0";

		const r = state.rules;
		refs.earn.replaceChildren();
		refs.spend.replaceChildren();
		const line = (parent, text, value, plus) => {
			const row = el("div", "sw-row");
			row.appendChild(el("span", "", text));
			if (value) row.appendChild(el("span", plus ? "sw-plus" : "sw-minus", value));
			parent.appendChild(row);
		};
		// Rules server se aaye to amounts ke saath, warna bina amount ke (galat number na dikhe).
		line(refs.earn, "Watch a full reel", r ? `+${r.reel}` : "", true);
		line(refs.earn, r ? `Watch a full reel longer than ${r.longReelSec}s` : "Watch a long reel for a bigger reward", r ? `+${r.longReel}` : "", true);
		line(refs.earn, "Friend joins with your link and chats", r ? `+${r.referrer}` : "", true);
		line(refs.spend, r ? `Chat with a woman (after she sends ${r.chatAfterMessages} messages)` : "Chat with a woman", r ? `-${r.chat}` : "", false);

		const code = state.referralCode;
		refs.refBox.style.display = code ? "" : "none";
		refs.refInput.value = code ? `${state.appUrl}/?ref=${code}` : "";
		refs.refNote.textContent = r ? `Your friend gets ${r.newUser} credits, you get ${r.referrer} (once, when they first chat with someone).` : "";

		refs.history.replaceChildren();
		if (state.disabled) refs.history.appendChild(el("div", "sw-empty", "Credits are not available right now. Please try again later."));
		else if (!state.signedIn) refs.history.appendChild(el("div", "sw-empty", "Sign in with Gmail to earn and keep credits."));
		else if (!state.history.length) refs.history.appendChild(el("div", "sw-empty", "No activity yet. Watch a reel to earn your first credits!"));
		for (const item of state.history) {
			const row = el("div", "sw-row");
			const left = el("span", "", label(String(item.reason)));
			left.appendChild(el("span", "sw-sub", new Date(item.at).toLocaleString()));
			row.append(left, el("span", item.amount >= 0 ? "sw-plus" : "sw-minus", `${item.amount >= 0 ? "+" : ""}${item.amount}`));
			refs.history.appendChild(row);
		}
	}

	function build() {
		const style = el("style");
		style.textContent = css;
		document.head.appendChild(style);

		refs.chip = el("button", "sw-chip");
		refs.chip.type = "button";
		refs.chip.addEventListener("click", () => open());

		refs.overlay = el("div", "sw-overlay");
		refs.overlay.addEventListener("click", (event) => { if (event.target === refs.overlay) close(); });
		const card = el("div", "sw-card");
		const head = el("div", "sw-head");
		const close_ = el("button", "sw-x", "×");
		close_.type = "button";
		close_.addEventListener("click", close);
		head.append(el("h2", "", "My credits"), close_);

		refs.msg = el("div", "sw-msg");
		const bal = el("div", "sw-bal");
		refs.balance = el("b", "", "0");
		bal.append(refs.balance, el("span", "", "credits available"));

		const earnSec = el("div", "sw-sec");
		refs.earn = el("div");
		earnSec.append(el("h3", "", "How to earn"), refs.earn);
		const spendSec = el("div", "sw-sec");
		refs.spend = el("div");
		spendSec.append(el("h3", "", "Where they are used"), refs.spend);

		refs.refBox = el("div", "sw-sec");
		const refRow = el("div", "sw-ref");
		refs.refInput = el("input");
		refs.refInput.readOnly = true;
		const copy = el("button", "", "Copy");
		copy.type = "button";
		copy.addEventListener("click", async () => {
			try { await navigator.clipboard.writeText(refs.refInput.value); } catch { refs.refInput.select(); document.execCommand("copy"); }
			toast("Referral link copied");
		});
		refRow.append(refs.refInput, copy);
		refs.refNote = el("span", "sw-sub");
		refs.refBox.append(el("h3", "", "Invite friends"), refRow, refs.refNote);

		const histSec = el("div", "sw-sec");
		refs.history = el("div");
		histSec.append(el("h3", "", "Recent activity"), refs.history);

		card.append(head, bal, refs.msg, earnSec, spendSec, refs.refBox, histSec);
		refs.overlay.appendChild(card);
		document.body.append(refs.chip, refs.overlay);
		render();
	}

	function open(message) {
		state.open = true;
		refs.msg.textContent = typeof message === "string" ? message : "";
		refs.msg.classList.toggle("sw-show", typeof message === "string" && message !== "");
		refs.overlay.classList.add("sw-show");
		if (state.send) state.send({ type: "get-wallet" });
		render();
	}

	function close() {
		state.open = false;
		refs.overlay.classList.remove("sw-show");
	}

	// script.js ke WebSocket onmessage se har server message yahan bhejo.
	function handle(message) {
		if (!message || typeof message !== "object") return;
		switch (message.type) {
			case "wallet":
				state.credits = message.credits;
				state.signedIn = true;
				if (message.referralCode) state.referralCode = message.referralCode;
				if (message.rules) state.rules = message.rules;
				if (message.charged > 0) toast(`-${message.charged} credits (chat with a woman)`);
				if (state.open && state.send) state.send({ type: "get-wallet" });
				break;
			case "wallet-dashboard":
				if (message.enabled === false) { state.disabled = true; break; }
				state.disabled = false;
				state.signedIn = Boolean(message.signedIn);
				if (message.rules) state.rules = message.rules;
				if (state.signedIn) {
					state.credits = message.credits;
					state.referralCode = message.referralCode || "";
					state.history = message.history || [];
				}
				break;
			case "reel-reward":
				if (message.rewarded) toast(`+${message.credits} credits for watching the full reel 🎉`);
				else if (message.reason === "login-required" && !state.warnedLogin) { state.warnedLogin = true; toast("Sign in with Gmail to earn credits"); }
				break;
			case "referral-bonus":
				toast(message.role === "referrer" ? `A friend joined! +${message.credits} credits` : `Welcome bonus: +${message.credits} credits`);
				break;
			case "need-credits":
				open(message.message);
				return;
			default:
				return;
		}
		if (refs.chip) render();
	}

	// Reel ki <video> ko jodo: sirf poori reel dekhne par server ko "end" jaata hai.
	function watchVideo(video, reelId) {
		if (!video || reelId === undefined || reelId === null || video.__swWatch) return;
		video.__swWatch = true;
		let started = false, done = false, reachedEnd = false, played = 0, last = null;
		const send = (phase) => state.send && state.send({ type: "reel-watched", reelId: String(reelId), phase });
		const check = () => {
			if (done || !reachedEnd || !isFinite(video.duration) || video.duration <= 0) return;
			if (played >= video.duration * 0.9) { done = true; send("end"); }
		};
		video.addEventListener("play", () => {
			last = video.currentTime;
			if (!started) { started = true; send("start"); }
		});
		video.addEventListener("seeking", () => { last = null; });
		video.addEventListener("timeupdate", () => {
			const t = video.currentTime;
			if (last !== null) { const delta = t - last; if (delta > 0 && delta < 1.5) played += delta; }
			last = t;
			if (isFinite(video.duration) && t >= video.duration - 0.8) reachedEnd = true;
			check();
		});
		video.addEventListener("ended", () => { reachedEnd = true; check(); });
	}

	// Wallet button par click: purana handler roko, naya dashboard kholo.
	document.addEventListener("click", (event) => {
		const target = event.target && event.target.closest ? event.target.closest("[data-sw-bound]") : null;
		if (target) { event.preventDefault(); event.stopPropagation(); open(); }
	}, true);

	// Reels: agar <video> (ya uske parent) par data-reel-id ho to apne aap jud jaata hai. Warna reels.js se watchVideo(video, id) bulao.
	function autoWire(root) {
		const videos = root.querySelectorAll ? root.querySelectorAll("video") : [];
		for (const video of videos) {
			const holder = video.closest("[data-reel-id]");
			const id = video.dataset.reelId || (holder && holder.dataset.reelId);
			if (id) watchVideo(video, id);
		}
	}

	function init(options = {}) {
		if (typeof options.send === "function") state.send = options.send;
		if (options.appUrl) state.appUrl = String(options.appUrl).replace(/\/+$/, "");
	}

	function start() {
		build();
		autoWire(document);
		let queued = false;
		new MutationObserver(() => {
			if (queued) return;
			queued = true;
			setTimeout(() => {
				queued = false;
				autoWire(document);
				// Wallet button baad me bane to use bhi jod do (render sirf tab, taaki loop na bane).
				if (!document.querySelector("[data-sw-bound]") && findWalletButton()) render();
			}, 200);
		}).observe(document.body, { childList: true, subtree: true });
	}
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
	else start();

	window.StrangelyWallet = { init, handle, open, close, watchVideo };
})();
