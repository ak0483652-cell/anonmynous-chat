// Strangely Reels: full-screen vertical feed (Instagram jaisa).
// - Sab dekh sakte hain. Like/comment ke liye Gmail sign-in chahiye (wahi Firebase login jo chat mein hai).
// - Sirf admin (Render ke ADMIN_EMAILS mein jo Gmail ho) reels upload/delete kar sakta hai.
// - Videos Cloudinary se aati hain; sirf screen wali reel play hoti hai.
(function () {
	"use strict";

	const WS_URL = window.STRANGELY_WS_URL || "";
	const API = String(window.STRANGELY_API_BASE || (WS_URL ? WS_URL.replace(/^ws/, "http").replace(/\/ws\/?$/, "") : "")).replace(/\/+$/, "");
	const MAX_VIDEO_MB = 80;
	const MAX_VIDEO_SECONDS = 120;

	// Data saver: user jo quality chune, saari reels usi mein chalti hain jab tak wo badle.
	// Purani reels ko kuch nahi hota: sirf video ke URL ka transform hissa badalta hai (database same rehta hai).
	const QUALITIES = [
		{ key: "480", label: "480p", name: "Low quality", width: 480, q: "q_auto" },
		{ key: "720", label: "720p", name: "High quality", width: 720, q: "q_auto" }
	];
	const DEFAULT_QUALITY = "480";
	const QUALITY_KEY = "strangely_reels_quality";

	function loadQuality() {
		try {
			const saved = localStorage.getItem(QUALITY_KEY);
			if (QUALITIES.some((item) => item.key === saved)) return saved;
		} catch {
			// storage band ho to default
		}
		return DEFAULT_QUALITY;
	}

	function qualityUrl(url) {
		const item = QUALITIES.find((entry) => entry.key === state.quality) || QUALITIES[0];
		return String(url).replace(/\/video\/upload\/[^/]+\/(reels\/)/, `/video/upload/${item.q},w_${item.width},c_limit,vc_h264/$1`);
	}

	const state = {
		built: false,
		open: false,
		reels: [],
		next: null,
		exhausted: false, // true = feed ki saari reels aa chuki hain
		quality: loadQuality(),
		loading: false,
		muted: true,
		me: { signedIn: false, admin: false, uploads: false },
		commentsReel: null,
		commentsNext: null
	};
	const ui = {};
	let loadObserver = null;
	let playObserver = null;
	let toastTimer = 0;

	// ---------- helpers ----------
	function h(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	function toast(message) {
		if (typeof window.showToast === "function") return window.showToast(message);
		let node = document.getElementById("reels-toast");
		if (!node) {
			node = h("div", "reels-toast");
			node.id = "reels-toast";
			document.body.appendChild(node);
		}
		node.textContent = message;
		node.classList.add("show");
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => node.classList.remove("show"), 2600);
	}

	function formatCount(n) {
		n = Number(n) || 0;
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
		if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
		return String(n);
	}

	function timeAgo(iso) {
		const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
		if (seconds < 60) return "now";
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
		if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
		return `${Math.floor(seconds / 86400)}d`;
	}

	const ICONS = {
		heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.3C.9 8.4 2.7 4.5 6.4 4.5c2.2 0 3.9 1.2 5.6 3.2 1.7-2 3.4-3.2 5.6-3.2 3.7 0 5.5 3.9 4 7.2C19.5 16.4 12 21 12 21z"/></svg>',
		comment: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 01-12.3 7.6L3 21l1.9-5.5A8.5 8.5 0 1121 11.5z"/></svg>',
		share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 3L10.5 13.5M22 3l-7 18-4.5-7.5L3 9l19-6z"/></svg>',
		trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>',
		mute: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4zM17 9l5 6M22 9l-5 6"/></svg>',
		sound: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4zM16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12"/></svg>',
		coin: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 6.5v11M9.2 9.3c0-1 1.2-1.8 2.8-1.8s2.8.8 2.8 1.8-1.2 1.6-2.8 2-2.8 1-2.8 2 1.2 1.8 2.8 1.8 2.8-.8 2.8-1.8"/></svg>',
		plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
		close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
		flag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21V4m0 0h11l-2 4 2 4H5"/></svg>'
	};

	function iconButton(icon, label, className) {
		const button = h("button", `reels-btn ${className || ""}`);
		button.type = "button";
		button.setAttribute("aria-label", label);
		button.innerHTML = icon; // sirf apne static icons, user ka data nahi
		return button;
	}

	async function getToken() {
		try {
			return (window.strangelyAuth && (await window.strangelyAuth.getToken())) || "";
		} catch {
			return "";
		}
	}

	async function api(path, { method = "GET", body, auth = true } = {}) {
		const headers = {};
		if (body !== undefined) headers["content-type"] = "application/json";
		if (auth) {
			const token = await getToken();
			if (token) headers.authorization = `Bearer ${token}`;
		}
		const response = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
		let data = null;
		try {
			data = await response.json();
		} catch {
			// empty body
		}
		if (!response.ok) throw Object.assign(new Error((data && data.error) || `http_${response.status}`), { status: response.status });
		return data;
	}

	// Like/comment se pehle Gmail sign-in. true = ab signed in hai.
	async function ensureLogin() {
		const auth = window.strangelyAuth;
		if (!auth) {
			toast("Sign-in abhi available nahi hai.");
			return false;
		}
		if (await auth.getToken()) return true;
		toast("Like/comment ke liye Gmail se sign in karo.");
		const token = await auth.signIn();
		if (token) {
			await refreshMe();
			return true;
		}
		return false;
	}

	async function refreshMe(explain) {
		try {
			state.me = await api("/api/reels/me");
		} catch {
			state.me = { signedIn: false, admin: false, uploads: false };
		}
		if (ui.addButton) ui.addButton.hidden = !state.me.admin;
		if (ui.signInButton) ui.signInButton.hidden = state.me.signedIn;
		if (explain && state.me.signedIn) {
			if (state.me.admin) toast("Admin login ho gaya. Upar + se reel upload karo.");
			else toast(`${state.me.email || "Ye Gmail"} admin nahi hai. Render ke ADMIN_EMAILS mein yahi Gmail daalo.`);
		}
		document.querySelectorAll(".reel-delete").forEach((node) => (node.hidden = !state.me.admin));
	}

	// ---------- build UI ----------
	function build() {
		if (state.built) return;
		state.built = true;

		const overlay = h("div", "reels-overlay");
		overlay.hidden = true;
		overlay.setAttribute("role", "dialog");
		overlay.setAttribute("aria-label", "Reels");

		const stage = h("div", "reels-stage");
		const scroller = h("div", "reels-scroller");
		scroller.tabIndex = -1;

		const top = h("div", "reels-top");
		const closeButton = iconButton(ICONS.close, "Close reels", "reels-close");
		const title = h("strong", "reels-title", "Reels");
		const right = h("div", "reels-top-right");
		const addButton = iconButton(ICONS.plus, "Upload a reel", "reels-add");
		addButton.hidden = true;
		const signInButton = h("button", "reels-signin", "Sign in");
		signInButton.type = "button";
		signInButton.hidden = true;
		const muteButton = iconButton(ICONS.mute, "Unmute", "reels-mute");
		const qualityButton = h("button", "reels-quality", "");
		qualityButton.type = "button";
		qualityButton.setAttribute("aria-label", "Video quality (data saver)");
		right.append(signInButton, addButton, qualityButton, muteButton);
		top.append(closeButton, title, right);

		const qualityMenu = h("div", "reels-quality-menu");
		qualityMenu.hidden = true;
		qualityMenu.setAttribute("role", "menu");
		const menuTitle = h("p", "quality-title", "Data saver");
		qualityMenu.appendChild(menuTitle);
		for (const item of QUALITIES) {
			const option = h("button", "quality-option");
			option.type = "button";
			option.dataset.key = item.key;
			option.append(h("strong", "", item.label), h("span", "", item.name));
			option.addEventListener("click", () => {
				setQuality(item.key);
				qualityMenu.hidden = true;
			});
			qualityMenu.appendChild(option);
		}

		const status = h("div", "reels-status");
		const statusText = h("span", "reels-status-text");
		const retry = h("button", "reels-retry", "Dobara try karo");
		retry.type = "button";
		retry.hidden = true;
		retry.addEventListener("click", () => {
			state.error = false;
			loadMore();
		});
		status.append(statusText, retry);
		status.hidden = true;

		stage.append(scroller, top, status, qualityMenu);
		overlay.append(stage);
		document.body.appendChild(overlay);

		Object.assign(ui, { overlay, stage, scroller, status, statusText, retry, addButton, signInButton, muteButton, closeButton, qualityButton, qualityMenu });

		qualityButton.addEventListener("click", () => {
			qualityMenu.hidden = !qualityMenu.hidden;
		});
		// Menu ke bahar tap karne par band ho jaye
		stage.addEventListener("click", (event) => {
			if (!qualityMenu.hidden && !event.target.closest(".reels-quality-menu, .reels-quality")) qualityMenu.hidden = true;
		});
		renderQuality();

		closeButton.addEventListener("click", closeOverlay);
		muteButton.addEventListener("click", () => setMuted(!state.muted));
		addButton.addEventListener("click", openUpload);
		signInButton.addEventListener("click", async () => {
			if (await ensureLogin()) await refreshMe(true);
		});
		document.addEventListener("keydown", (event) => state.open && onKey(event));

		buildCommentsSheet();

		loadObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const video = entry.target.querySelector("video");
					if (!video) continue;
					if (entry.isIntersecting) {
						if (!video.getAttribute("src")) {
							video.src = video.dataset.src;
							video.preload = "metadata";
						}
					} else if (video.getAttribute("src")) {
						// Door wali reels ki memory chhodo (phone pe zaroori)
						video.pause();
						video.removeAttribute("src");
						video.load();
					}
				}
			},
			{ root: scroller, rootMargin: "150% 0px" }
		);

		playObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const video = entry.target.querySelector("video");
					if (!video) continue;
					if (entry.isIntersecting && state.open) {
						if (!video.getAttribute("src")) video.src = video.dataset.src;
						video.muted = state.muted;
						entry.target.classList.add("playing-now");
						video.loop = !isLastSlide(entry.target); // aakhri reel loop nahi hogi, khatam hote hi pehli pe jayegi
						const played = video.play();
						if (played && played.catch) played.catch(() => entry.target.classList.add("paused"));
						entry.target.classList.remove("paused");
						const index = Number(entry.target.dataset.index);
						if (index >= state.reels.length - 3) loadMore();
					} else {
						entry.target.classList.remove("playing-now");
						video.pause();
					}
				}
			},
			{ root: scroller, threshold: 0.65 }
		);

		document.addEventListener("visibilitychange", () => {
			if (document.hidden) pauseAll();
		});
		window.addEventListener("popstate", () => {
			if (state.open && !(history.state && history.state.reels)) hideOverlay();
		});
	}

	function renderQuality() {
		const current = QUALITIES.find((item) => item.key === state.quality) || QUALITIES[0];
		ui.qualityButton.textContent = current.label;
		ui.qualityMenu.querySelectorAll(".quality-option").forEach((option) => option.classList.toggle("active", option.dataset.key === state.quality));
	}

	function setQuality(key) {
		if (key === state.quality) return;
		state.quality = key;
		try {
			localStorage.setItem(QUALITY_KEY, key);
		} catch {
			// ignore
		}
		renderQuality();
		// Saari reels ka URL naya karo. Jo reel abhi chal rahi hai wo usi second se aage chalti rahe.
		ui.scroller.querySelectorAll(".reel").forEach((slide) => {
			const reel = state.reels.find((item) => item.id === slide.dataset.id);
			const video = slide.querySelector("video");
			if (!reel || !video) return;
			const newUrl = qualityUrl(reel.videoUrl);
			video.dataset.src = newUrl;
			if (!video.getAttribute("src")) return; // door wali reel: jab aayegi tab naya URL lagega
			const resumeAt = video.currentTime || 0;
			const wasPlaying = !video.paused;
			video._tries = 0;
			slide.classList.remove("failed");
			video.addEventListener(
				"loadedmetadata",
				() => {
					try {
						video.currentTime = resumeAt;
					} catch {
						// ignore
					}
					if (wasPlaying) video.play().catch(() => {});
				},
				{ once: true }
			);
			video.src = newUrl;
		});
		const item = QUALITIES.find((entry) => entry.key === key);
		toast(`${item.label} (${item.name}) laga diya. Ab saari reels isi mein chalengi.`);
	}

	// Feed ki aakhri reel? (jab saari reels aa chuki hon)
	function isLastSlide(slide) {
		return state.exhausted && slide === ui.scroller.lastElementChild;
	}

	function setMuted(muted) {
		state.muted = muted;
		ui.muteButton.innerHTML = muted ? ICONS.mute : ICONS.sound;
		ui.muteButton.setAttribute("aria-label", muted ? "Unmute" : "Mute");
		ui.scroller.querySelectorAll("video").forEach((video) => (video.muted = muted));
	}

	function pauseAll() {
		if (ui.scroller) ui.scroller.querySelectorAll("video").forEach((video) => video.pause());
	}

	function onKey(event) {
		if (event.target.closest && event.target.closest("input, textarea")) {
			if (event.key === "Escape") closeSheetOrOverlay();
			return;
		}
		const height = ui.scroller.clientHeight;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			ui.scroller.scrollBy({ top: height, behavior: "smooth" });
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			ui.scroller.scrollBy({ top: -height, behavior: "smooth" });
		} else if (event.key === "Escape") {
			closeSheetOrOverlay();
		} else if (event.key === "m" || event.key === "M") {
			setMuted(!state.muted);
		}
	}

	function closeSheetOrOverlay() {
		if (ui.sheet && ui.sheet.classList.contains("open")) closeComments();
		else closeOverlay();
	}

	// ---------- reel slides ----------
	function slideFor(reel, index) {
		const slide = h("section", "reel");
		slide.dataset.id = reel.id;
		slide.dataset.reelId = reel.id; // wallet-dashboard.js isse reel dekhne par credits deta hai
		slide.dataset.index = String(index);

		const video = document.createElement("video");
		video.className = "reel-video";
		video.loop = true;
		video.muted = true;
		video.playsInline = true;
		video.setAttribute("playsinline", "");
		video.setAttribute("webkit-playsinline", "");
		video.preload = "none";
		video.dataset.src = qualityUrl(reel.videoUrl);
		video._tries = 0;
		if (reel.posterUrl) video.poster = reel.posterUrl;
		// Aakhri reel khatam ho to feed ki pehli reel pe wapas. Baaki reels loop hoti rehti hain.
		video.addEventListener("ended", () => {
			const first = ui.scroller.firstElementChild;
			if (isLastSlide(slide) && first && first !== slide) {
				ui.scroller.scrollTo({ top: 0, behavior: "auto" });
			} else {
				video.currentTime = 0;
				video.play().catch(() => {});
			}
		});
		video.addEventListener("loadedmetadata", () => {
			if (video.videoWidth > video.videoHeight) video.classList.add("contain");
		});
		video.addEventListener("waiting", () => slide.classList.add("buffering"));
		video.addEventListener("playing", () => slide.classList.remove("buffering", "paused"));
		video.addEventListener("canplay", () => slide.classList.remove("buffering"));
		video.addEventListener("timeupdate", () => {
			if (video.duration) progress.style.width = `${(video.currentTime / video.duration) * 100}%`;
		});
		video.addEventListener("error", () => {
			if (!video.getAttribute("src")) return;
			// Nayi quality pehli baar Cloudinary banata hai (kuch second). Isliye 4 baar dobara try karo.
			if (video._tries < 4) {
				video._tries += 1;
				slide.classList.add("buffering");
				setTimeout(() => {
					if (video.getAttribute("src")) {
						video.src = video.dataset.src;
						if (slide.classList.contains("playing-now")) video.play().catch(() => {});
					}
				}, 3000);
				return;
			}
			slide.classList.add("failed");
		});

		const shade = h("div", "reel-shade");
		const progressWrap = h("div", "reel-progress");
		const progress = h("i");
		progressWrap.appendChild(progress);

		const pauseIcon = h("div", "reel-pause-icon", "▶");
		const spinner = h("div", "reel-spinner");
		const failed = h("div", "reel-failed", "Video load nahi ho payi.");
		const burst = h("div", "reel-burst");
		burst.innerHTML = ICONS.heart;

		const caption = h("p", "reel-caption", reel.caption);
		caption.hidden = !reel.caption;

		const actions = h("div", "reel-actions");
		const walletButton = iconButton(ICONS.coin, "Wallet", "reel-wallet");
		const walletCount = h("span", "reel-count reel-wallet-count", walletLabel());
		const likeButton = iconButton(ICONS.heart, "Like", "reel-like");
		const likeCount = h("span", "reel-count", formatCount(reel.likes));
		const commentButton = iconButton(ICONS.comment, "Comments", "reel-comment");
		const commentCount = h("span", "reel-count", formatCount(reel.comments));
		const shareButton = iconButton(ICONS.share, "Share", "reel-share");
		const shareLabel = h("span", "reel-count", "Share");
		const deleteButton = iconButton(ICONS.trash, "Delete reel", "reel-delete");
		deleteButton.hidden = !state.me.admin;
		const wrap = (button, label) => {
			const group = h("div", "reel-action");
			group.append(button, label);
			return group;
		};
		actions.append(wrap(walletButton, walletCount), wrap(likeButton, likeCount), wrap(commentButton, commentCount), wrap(shareButton, shareLabel), wrap(deleteButton, h("span", "reel-count", "")));
		likeButton.classList.toggle("liked", reel.liked);

		slide.append(video, shade, pauseIcon, spinner, failed, burst, caption, actions, progressWrap);
		slide._refs = { likeButton, likeCount, commentCount };

		// Tap = pause/play. Double tap = like.
		let lastTap = 0;
		let tapTimer = 0;
		slide.addEventListener("click", (event) => {
			if (event.target.closest(".reel-actions")) return;
			const now = Date.now();
			if (now - lastTap < 300) {
				clearTimeout(tapTimer);
				lastTap = 0;
				burst.classList.remove("go");
				void burst.offsetWidth;
				burst.classList.add("go");
				if (!reel.liked) setLike(reel, slide, true);
				return;
			}
			lastTap = now;
			tapTimer = setTimeout(() => {
				if (video.paused) {
					video.muted = state.muted;
					video.play().catch(() => {});
					slide.classList.remove("paused");
				} else {
					video.pause();
					slide.classList.add("paused");
				}
			}, 300);
		});

		walletButton.addEventListener("click", () => window.StrangelyWallet && window.StrangelyWallet.open());
		likeButton.addEventListener("click", () => setLike(reel, slide, !reel.liked));
		commentButton.addEventListener("click", () => openComments(reel, slide));
		shareButton.addEventListener("click", () => shareReel(reel));
		deleteButton.addEventListener("click", () => deleteReel(reel, slide));

		return slide;
	}

	// Wallet button ke neeche: sign-in ho to credits, warna "Wallet"
	function walletLabel() {
		const credits = window.StrangelyWallet && window.StrangelyWallet.getCredits ? window.StrangelyWallet.getCredits() : null;
		return credits === null || credits === undefined ? "Wallet" : formatCount(credits);
	}
	window.addEventListener("sw-credits", () => {
		const text = walletLabel();
		document.querySelectorAll(".reel-wallet-count").forEach((node) => (node.textContent = text));
	});

	function renderLike(reel, slide) {
		slide._refs.likeButton.classList.toggle("liked", reel.liked);
		slide._refs.likeCount.textContent = formatCount(reel.likes);
	}

	async function setLike(reel, slide, wantLiked) {
		if (reel.liked === wantLiked) return;
		if (!(await ensureLogin())) return;
		// Optimistic update
		reel.liked = wantLiked;
		reel.likes = Math.max(0, reel.likes + (wantLiked ? 1 : -1));
		renderLike(reel, slide);
		try {
			const result = await api(`/api/reels/${reel.id}/like`, { method: "POST", body: { liked: wantLiked } });
			reel.likes = result.likes;
			reel.liked = result.liked;
		} catch (error) {
			reel.liked = !wantLiked;
			reel.likes = Math.max(0, reel.likes + (wantLiked ? -1 : 1));
			toast(error.message === "slow_down" ? "Thoda dheere, thodi der baad try karo." : "Like nahi ho paya. Dobara try karo.");
		}
		renderLike(reel, slide);
	}

	async function shareReel(reel) {
		const url = `${location.origin}${location.pathname}#reel=${reel.id}`;
		const data = { title: "Strangely Reels", text: reel.caption || "Ye reel dekho", url };
		if (navigator.share) {
			try {
				await navigator.share(data);
				return;
			} catch (error) {
				if (error && error.name === "AbortError") return;
			}
		}
		try {
			await navigator.clipboard.writeText(url);
			toast("Link copy ho gaya!");
		} catch {
			window.prompt("Is link ko copy karo:", url);
		}
	}

	async function deleteReel(reel, slide) {
		if (!window.confirm("Ye reel hamesha ke liye delete karni hai?")) return;
		try {
			await api(`/api/reels/${reel.id}`, { method: "DELETE" });
			state.reels = state.reels.filter((item) => item.id !== reel.id);
			const video = slide.querySelector("video");
			video.pause();
			loadObserver.unobserve(slide);
			playObserver.unobserve(slide);
			slide.remove();
			ui.scroller.querySelectorAll(".reel").forEach((node, i) => (node.dataset.index = String(i)));
			toast("Reel delete ho gayi.");
			updateEmpty();
		} catch {
			toast("Delete nahi ho payi.");
		}
	}

	function appendReels(list) {
		const known = new Set(state.reels.map((reel) => reel.id));
		for (const reel of list) {
			if (known.has(reel.id)) continue;
			known.add(reel.id);
			const slide = slideFor(reel, state.reels.length);
			state.reels.push(reel);
			ui.scroller.appendChild(slide);
			loadObserver.observe(slide);
			playObserver.observe(slide);
		}
		updateEmpty();
	}

	function updateEmpty() {
		if (state.reels.length > 0 || state.loading) ui.status.hidden = true;
		else if (state.error) showStatus(state.errorText || "Reels load nahi ho payi.", true);
		else showStatus(state.configured === false ? "Reels jaldi aa rahi hain." : state.me.admin ? "Abhi koi reel nahi hai. Upar + se pehli reel upload karo." : "Abhi koi reel nahi hai. Admin ho to upar Sign in dabao.");
	}

	function showStatus(text, canRetry) {
		ui.statusText.textContent = text;
		ui.retry.hidden = !canRetry;
		ui.status.hidden = false;
	}

	async function loadMore() {
		if (state.loading || state.exhausted) return;
		state.loading = true;
		if (state.reels.length === 0) showStatus("Loading...");
		try {
			const query = state.next ? `?before=${encodeURIComponent(state.next)}` : "";
			const data = await api(`/api/reels${query}`);
			state.next = data.next;
			state.exhausted = !data.next;
			state.configured = true;
			state.error = false;
			appendReels(data.reels);
			const active = ui.scroller.querySelector(".reel.playing-now video");
			if (active) active.loop = !isLastSlide(active.closest(".reel"));
		} catch (error) {
			if (error.message === "reels_not_configured") state.configured = false;
			else {
				state.error = true;
				if (!error.status) state.errorText = "Server tak nahi pahunch paye. Render so raha ho sakta hai: 30 second baad Dobara try karo.";
				else if (error.status === 404) state.errorText = "Server pe reels ka code nahi mila. GitHub pe server.js aur reels-api.js root mein hain? Render ka deploy Live hai?";
				else state.errorText = "Server error. Supabase mein reels-schema.sql run hui? SUPABASE_URL aur SUPABASE_SERVICE_KEY sahi hain? (code " + error.status + ")";
				console.error("Reels load failed:", error.status || "network", error.message);
			}
		} finally {
			state.loading = false;
			updateEmpty();
		}
	}

	// ---------- comments ----------
	function buildCommentsSheet() {
		const sheet = h("div", "reels-sheet");
		sheet.setAttribute("role", "dialog");
		sheet.setAttribute("aria-label", "Comments");
		const head = h("div", "sheet-head");
		const heading = h("strong", "sheet-title", "Comments");
		const close = iconButton(ICONS.close, "Close comments", "sheet-close");
		head.append(heading, close);
		const list = h("div", "sheet-list");
		const more = h("button", "sheet-more", "Aur comments dikhao");
		more.type = "button";
		more.hidden = true;
		const form = h("form", "sheet-form");
		const input = h("input", "sheet-input");
		input.type = "text";
		input.maxLength = 300;
		input.placeholder = "Comment likho...";
		input.autocomplete = "off";
		input.setAttribute("aria-label", "Write a comment");
		const send = h("button", "sheet-send", "Post");
		send.type = "submit";
		form.append(input, send);
		sheet.append(head, list, more, form);
		ui.stage.appendChild(sheet);
		Object.assign(ui, { sheet, sheetList: list, sheetMore: more, sheetInput: input, sheetTitle: heading, sheetSend: send });

		close.addEventListener("click", closeComments);
		more.addEventListener("click", () => loadComments(false));
		input.addEventListener("focus", () => {
			if (!state.me.signedIn) ensureLogin();
		});
		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			const text = input.value.trim();
			if (!text || !state.commentsReel) return;
			if (!(await ensureLogin())) return;
			send.disabled = true;
			try {
				const data = await api(`/api/reels/${state.commentsReel.reel.id}/comments`, { method: "POST", body: { text } });
				input.value = "";
				const empty = list.querySelector(".sheet-empty");
				if (empty) empty.remove();
				list.prepend(commentNode(data.comment));
				bumpComments(1);
			} catch (error) {
				toast(error.message === "slow_down" ? "Thoda ruko, phir comment karo." : "Comment post nahi ho paya.");
			} finally {
				send.disabled = false;
			}
		});
	}

	function bumpComments(delta) {
		const { reel, slide } = state.commentsReel;
		reel.comments = Math.max(0, reel.comments + delta);
		slide._refs.commentCount.textContent = formatCount(reel.comments);
		ui.sheetTitle.textContent = `Comments (${formatCount(reel.comments)})`;
	}

	function commentNode(comment) {
		const row = h("div", "comment");
		const body = h("div", "comment-body");
		const meta = h("div", "comment-meta");
		meta.append(h("strong", "", comment.author), h("span", "", timeAgo(comment.createdAt)));
		body.append(meta, h("p", "comment-text", comment.text));
		row.appendChild(body);
		if (comment.mine || state.me.admin) {
			const del = iconButton(ICONS.trash, "Delete comment", "comment-act");
			del.addEventListener("click", async () => {
				try {
					await api(`/api/comments/${comment.id}`, { method: "DELETE" });
					row.remove();
					bumpComments(-1);
				} catch {
					toast("Delete nahi ho paya.");
				}
			});
			row.appendChild(del);
		} else {
			const report = iconButton(ICONS.flag, "Report comment", "comment-act");
			report.addEventListener("click", async () => {
				if (!(await ensureLogin())) return;
				try {
					await api(`/api/comments/${comment.id}/report`, { method: "POST", body: {} });
					toast("Report ho gaya. Shukriya.");
					report.disabled = true;
				} catch {
					toast("Report nahi ho paya.");
				}
			});
			row.appendChild(report);
		}
		return row;
	}

	async function openComments(reel, slide) {
		state.commentsReel = { reel, slide };
		state.commentsNext = null;
		ui.sheetList.replaceChildren();
		ui.sheetTitle.textContent = `Comments (${formatCount(reel.comments)})`;
		ui.sheet.classList.add("open");
		ui.stage.classList.add("sheet-open");
		ui.sheetMore.hidden = true;
		refreshMe();
		await loadComments(true);
	}

	async function loadComments(first) {
		const target = state.commentsReel;
		if (!target) return;
		try {
			const query = !first && state.commentsNext ? `?before=${encodeURIComponent(state.commentsNext)}` : "";
			const data = await api(`/api/reels/${target.reel.id}/comments${query}`);
			if (state.commentsReel !== target) return;
			state.commentsNext = data.next;
			for (const comment of data.comments) ui.sheetList.appendChild(commentNode(comment));
			if (first && data.comments.length === 0) ui.sheetList.appendChild(h("p", "sheet-empty", "Abhi koi comment nahi. Pehla comment tum karo!"));
			ui.sheetMore.hidden = !data.next;
		} catch {
			toast("Comments load nahi ho paye.");
		}
	}

	function closeComments() {
		ui.sheet.classList.remove("open");
		ui.stage.classList.remove("sheet-open");
		state.commentsReel = null;
	}

	// ---------- admin upload ----------
	function buildUpload() {
		const modal = h("div", "reels-modal");
		modal.hidden = true;
		const card = h("form", "modal-card");
		const title = h("h2", "", "Nayi reel upload karo");
		const file = h("input");
		file.type = "file";
		file.accept = "video/mp4,video/webm,video/quicktime";
		file.required = true;
		const hint = h("p", "modal-hint", `MP4 (H.264) best hai. Max ${MAX_VIDEO_MB} MB aur ${MAX_VIDEO_SECONDS} sec. 720p, 15-30 sec rakhoge to free Cloudinary limit bahut der chalegi.`);
		const caption = h("textarea");
		caption.rows = 3;
		caption.maxLength = 300;
		caption.placeholder = "Caption (optional)";
		const bar = h("div", "modal-bar");
		const fill = h("i");
		bar.appendChild(fill);
		bar.hidden = true;
		const message = h("p", "modal-msg");
		const row = h("div", "modal-row");
		const cancel = h("button", "modal-cancel", "Cancel");
		cancel.type = "button";
		const submit = h("button", "modal-submit", "Upload");
		submit.type = "submit";
		row.append(cancel, submit);
		card.append(title, file, hint, caption, bar, message, row);
		modal.appendChild(card);
		ui.stage.appendChild(modal);
		Object.assign(ui, { modal, uploadFile: file, uploadCaption: caption, uploadBar: bar, uploadFill: fill, uploadMsg: message, uploadSubmit: submit });

		let busy = false;
		cancel.addEventListener("click", () => {
			if (!busy) modal.hidden = true;
		});
		card.addEventListener("submit", async (event) => {
			event.preventDefault();
			if (busy || !file.files[0]) return;
			busy = true;
			submit.disabled = true;
			cancel.disabled = true;
			try {
				await uploadReel(file.files[0], caption.value.trim());
				file.value = "";
				caption.value = "";
				modal.hidden = true;
				toast("Reel upload ho gayi!");
				state.reels = [];
				state.next = null;
				state.exhausted = false;
				ui.scroller.replaceChildren();
				await loadMore();
			} catch (error) {
				message.textContent = error.userMessage || "Upload fail ho gaya. Dobara try karo.";
				console.error("Reel upload failed:", error);
			} finally {
				busy = false;
				submit.disabled = false;
				cancel.disabled = false;
				bar.hidden = true;
			}
		});
	}

	function openUpload() {
		if (!ui.modal) buildUpload();
		ui.uploadMsg.textContent = "";
		ui.modal.hidden = false;
	}

	function fail(userMessage) {
		return Object.assign(new Error(userMessage), { userMessage });
	}

	function once(target, eventName, timeoutMs) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timeout ${eventName}`)), timeoutMs || 15000);
			target.addEventListener(
				eventName,
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true }
			);
			target.addEventListener("error", () => reject(new Error("media error")), { once: true });
		});
	}

	// Video ki duration browser ke andar hi nikaalte hain (galat/na chalne wali video pehle hi pakad lete hain).
	async function videoDuration(file) {
		const url = URL.createObjectURL(file);
		try {
			const video = document.createElement("video");
			video.muted = true;
			video.playsInline = true;
			video.preload = "metadata";
			video.src = url;
			try {
				await once(video, "loadedmetadata");
			} catch {
				throw fail("Ye video browser mein play nahi ho sakti. MP4 (H.264) mein convert karke upload karo.");
			}
			return video.duration;
		} finally {
			URL.revokeObjectURL(url);
		}
	}

	// Cloudinary ko signed form POST (file sabse aakhir mein jaani chahiye)
	function postToCloudinary(upload, file, onProgress) {
		return new Promise((resolve, reject) => {
			const form = new FormData();
			Object.entries(upload.fields).forEach(([key, value]) => form.append(key, value));
			form.append("file", file);
			const xhr = new XMLHttpRequest();
			xhr.open("POST", upload.uploadUrl);
			xhr.upload.onprogress = (event) => event.lengthComputable && onProgress(event.loaded / event.total);
			xhr.onload = () => {
				if (xhr.status >= 200 && xhr.status < 300) return resolve();
				let detail = "";
				try {
					detail = JSON.parse(xhr.responseText).error.message;
				} catch {
					// ignore
				}
				reject(Object.assign(new Error(`Cloudinary upload status ${xhr.status}: ${detail}`), { userMessage: detail ? `Cloudinary ne mana kiya: ${detail}` : "Cloudinary upload fail ho gaya." }));
			};
			xhr.onerror = () => reject(Object.assign(new Error("Cloudinary network error"), { userMessage: "Cloudinary tak nahi pahunch paye. Internet check karo." }));
			xhr.send(form);
		});
	}

	// Cloudinary pehli baar video ko 720p MP4 banata hai. Jab tak taiyar nahi hoti (423), thoda ruko.
	async function waitUntilReady(url) {
		const deadline = Date.now() + 120000;
		while (Date.now() < deadline) {
			try {
				const response = await fetch(url);
				if (response.body) response.body.cancel();
				if (response.ok) return true;
				if (response.status !== 423 && response.status !== 404) return false;
			} catch {
				return false;
			}
			await new Promise((resolve) => setTimeout(resolve, 3000));
		}
		return false;
	}

	async function uploadReel(file, caption) {
		const type = file.type || "video/mp4";
		if (!["video/mp4", "video/webm", "video/quicktime"].includes(type)) throw fail("Sirf MP4, WebM ya MOV video chalegi.");
		if (file.size > MAX_VIDEO_MB * 1024 * 1024) throw fail(`Video ${MAX_VIDEO_MB} MB se chhoti honi chahiye.`);
		ui.uploadBar.hidden = false;
		ui.uploadFill.style.width = "0%";
		ui.uploadMsg.textContent = "Video check ho rahi hai...";
		const duration = await videoDuration(file);
		if (duration > MAX_VIDEO_SECONDS) throw fail(`Video ${MAX_VIDEO_SECONDS} sec se chhoti honi chahiye.`);

		try {
			ui.uploadMsg.textContent = "Upload ho rahi hai...";
			const upload = await api("/api/reels/presign", { method: "POST", body: {} });
			await postToCloudinary(upload, file, (fraction) => (ui.uploadFill.style.width = `${Math.round(fraction * 80)}%`));
			ui.uploadMsg.textContent = "Video phone ke liye taiyar ho rahi hai (kuch second)...";
			ui.uploadFill.style.width = "90%";
			await waitUntilReady(upload.videoUrl);
			ui.uploadMsg.textContent = "Save ho rahi hai...";
			await api("/api/reels", { method: "POST", body: { publicId: upload.publicId, caption } });
			ui.uploadFill.style.width = "100%";
		} catch (error) {
			if (error.message === "admin_only") throw fail("Sirf admin upload kar sakta hai. Sahi Gmail se sign in karo.");
			if (error.message === "cloudinary_not_configured") throw fail("Cloudinary ki settings Render mein nahi mili (CLOUDINARY_* environment variables).");
			throw error;
		}
	}

	// ---------- open / close ----------
	async function openOverlay(startId) {
		build();
		if (state.open) return;
		state.open = true;
		ui.overlay.hidden = false;
		document.documentElement.classList.add("reels-lock");
		if (/^#reel/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search);
		history.pushState({ reels: true }, "", "#reels");
		ui.scroller.focus({ preventScroll: true });

		await refreshMe(); // Firebase pehle load ho jaata hai, taaki baad mein sign-in popup block na ho
		if (state.reels.length === 0) {
			if (startId) {
				try {
					const data = await api(`/api/reels/${startId}`);
					appendReels([data.reel]);
				} catch {
					// reel nahi mili: normal feed dikhao
				}
			}
			await loadMore();
		} else if (startId) {
			const slide = ui.scroller.querySelector(`[data-id="${startId}"]`);
			if (slide) slide.scrollIntoView();
		}
	}

	function hideOverlay() {
		if (!state.open) return;
		state.open = false;
		pauseAll();
		closeComments();
		if (ui.modal) ui.modal.hidden = true;
		ui.overlay.hidden = true;
		document.documentElement.classList.remove("reels-lock");
	}

	function closeOverlay() {
		if (history.state && history.state.reels) history.back();
		else hideOverlay();
	}

	// ---------- entry points ----------
	function init() {
		document.querySelectorAll("[data-open-reels]").forEach((button) => button.addEventListener("click", () => openOverlay()));
		const match = /^#reel=([0-9a-f-]{36})$/i.exec(location.hash);
		if (match) openOverlay(match[1]);
	}
	window.strangelyReels = { open: openOverlay };
	window.addEventListener("hashchange", () => {
		const match = /^#reel=([0-9a-f-]{36})$/i.exec(location.hash);
		if (match && !state.open) openOverlay(match[1]);
	});
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
	else init();
})();
// ---- Last reel ke baad pehli reel (swipe, scroll, arrow key, ya reel khatam hone par) ----
(function () {
	var lastWrap = 0, lastWheel = 0, arrivedAt = 0, startedAtEnd = false, startY = null;

	function scroller() { return document.querySelector(".reels-scroller"); }
	function atEnd(s) { return s.scrollTop + s.clientHeight >= s.scrollHeight - 4; }

	function wrap() {
		var s = scroller();
		if (!s) return;
		var slides = s.querySelectorAll(".reel");
		if (slides.length < 2 || Date.now() - lastWrap < 900) return;
		lastWrap = Date.now();
		try { slides[0].querySelector("video").currentTime = 0; } catch (e) {}
		s.scrollTop = 0;
	}

	// Sabse aakhri reel loop na kare (warna "ended" nahi aata). Sirf ek reel ho to loop chalta rahe.
	setInterval(function () {
		var s = scroller();
		if (!s) return;
		var slides = s.querySelectorAll(".reel");
		slides.forEach(function (slide, i) {
			var video = slide.querySelector("video");
			if (video) video.loop = !(slides.length > 1 && i === slides.length - 1);
		});
		// Kab last reel par pahunche (taaki swipe ki inertia se turant wapas na ud jaye)
		if (atEnd(s)) { if (!arrivedAt) arrivedAt = Date.now(); } else { arrivedAt = 0; }
	}, 100);

	// 1) Last reel poori chal gayi
	document.addEventListener("ended", function (event) {
		var s = scroller();
		var video = event.target;
		if (!s || !(video instanceof HTMLVideoElement)) return;
		var slides = s.querySelectorAll(".reel");
		if (slides[slides.length - 1] === video.closest(".reel")) wrap();
	}, true);

	// 2) Mouse wheel / trackpad: last reel par pahunchke naya scroll karo
	document.addEventListener("wheel", function (e) {
		var s = scroller();
		var now = Date.now();
		var freshGesture = now - lastWheel > 200;
		lastWheel = now;
		if (s && s.contains(e.target) && e.deltaY > 10 && freshGesture && arrivedAt && now - arrivedAt > 500 && atEnd(s)) wrap();
	}, { passive: true });

	// 3) Phone: last reel par ungli se upar swipe
	document.addEventListener("touchstart", function (e) {
		var s = scroller();
		startY = e.touches[0].clientY;
		startedAtEnd = !!(s && s.contains(e.target) && arrivedAt && Date.now() - arrivedAt > 300 && atEnd(s));
	}, { passive: true });
	document.addEventListener("touchend", function (e) {
		var s = scroller();
		var dy = startY === null ? 0 : startY - e.changedTouches[0].clientY;
		startY = null;
		if (s && startedAtEnd && dy > 50 && atEnd(s)) wrap();
		startedAtEnd = false;
	}, { passive: true });

	// 4) Keyboard Down arrow
	document.addEventListener("keydown", function (e) {
		var s = scroller();
		if (s && e.key === "ArrowDown" && arrivedAt && Date.now() - arrivedAt > 300 && atEnd(s) && s.offsetParent !== null) {
			e.preventDefault();
			e.stopImmediatePropagation(); // reels.js ka apna "agli reel" scroll ruk jaye
			wrap();
		}
	});
})();
