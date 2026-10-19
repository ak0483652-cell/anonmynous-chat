// Strangely wallet UI. script.js se `window.walletOnMessage` ke through server ke messages milte hain.
// Sab kuch textContent se banta hai (koi innerHTML nahi), taaki kisi ka naam/UPI page ko kharab na kare.
(function () {
	"use strict";

	var state = null;
	var listening = false;
	var rzpLoading = null;
	var bannerTimer = null;
	var dialog = null;
	var openButton = null;
	var banner = null;

	function h(tag, props, children) {
		var node = document.createElement(tag);
		Object.keys(props || {}).forEach(function (key) {
			if (props[key] === null || props[key] === undefined) return;
			if (key === "class") node.className = props[key];
			else if (key === "text") node.textContent = props[key];
			else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), props[key]);
			else node.setAttribute(key, props[key]);
		});
		(children || []).forEach(function (child) {
			if (child) node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
		});
		return node;
	}

	function rupees(paise) {
		return "₹" + (Number(paise || 0) / 100).toFixed(2);
	}

	function number(value) {
		return Number(value || 0).toLocaleString("en-IN");
	}

	function toast(message) {
		if (typeof showToast === "function") showToast(message);
	}

	function send(message) {
		return typeof sendToServer === "function" ? sendToServer(message) : false;
	}

	function requestState() {
		send({ type: "wallet-get" });
	}

	function loadRazorpay() {
		if (window.Razorpay) return Promise.resolve();
		if (!rzpLoading) {
			rzpLoading = new Promise(function (resolve, reject) {
				var script = document.createElement("script");
				script.src = "https://checkout.razorpay.com/v1/checkout.js";
				script.onload = resolve;
				script.onerror = function () { rzpLoading = null; reject(new Error("load failed")); };
				document.head.appendChild(script);
			});
		}
		return rzpLoading;
	}

	function openCheckout(order) {
		if (dialog && dialog.open) dialog.close(); // modal dialog Razorpay ke upar aa jata hai, isliye band karo
		loadRazorpay().then(function () {
			var checkout = new window.Razorpay({
				key: order.keyId,
				amount: order.amount,
				currency: "INR",
				name: "Strangely",
				description: number(order.credits) + " chat credits",
				order_id: order.orderId,
				theme: { color: "#3b6df0" },
				handler: function (response) {
					send({ type: "wallet-verify", orderId: response.razorpay_order_id, paymentId: response.razorpay_payment_id, signature: response.razorpay_signature });
				}
			});
			checkout.open();
		}).catch(function () {
			toast("Payment window load nahi hui. Internet check karke dobara try karo.");
		});
	}

	function section(title, children) {
		return h("section", { class: "wallet-section" }, [h("h3", { text: title })].concat(children));
	}

	function note(text) {
		return h("p", { class: "wallet-note", text: text });
	}

	function stat(label, value) {
		return h("div", { class: "wallet-stat" }, [h("span", { text: label }), h("strong", { text: value })]);
	}

	function render() {
		if (!dialog) return;
		var body = dialog.querySelector(".wallet-body");
		body.textContent = "";

		if (!state || state.enabled === false) {
			body.appendChild(note("Wallet abhi chalu nahi hai."));
			return;
		}
		if (!state.signedIn) {
			body.appendChild(note("Credits aur kamaai ke liye Gmail se sign in karna zaroori hai."));
			body.appendChild(h("button", { class: "wallet-primary", type: "button", text: "Profile kholo", onclick: function () {
				dialog.close();
				var edit = document.querySelector("#edit-profile");
				if (edit) edit.click();
			} }));
			return;
		}

		body.appendChild(h("div", { class: "wallet-stats" }, [
			stat("Credits", number(state.credits)),
			stat("Kamaai (withdraw ho sakti hai)", rupees(state.earnPaise)),
			stat("Hold me (" + state.holdDays + " din baad khulti hai)", rupees(state.pendingPaise))
		]));

		body.appendChild(section("Paid chat", [
			note("Ek connect: " + number(state.cost) + " credits (≈ " + rupees(state.costPaise) + "), max " + state.maxMinutes + " minute. Samne wale ne " + state.minValidTexts + " asli reply nahi diye to credits poore wapas."),
			h("button", { class: "wallet-primary", type: "button", text: "Listener se connect karo", onclick: function () {
				var preference = document.querySelector("#match-preference");
				dialog.close();
				send({ type: "find-paid", preference: preference ? preference.value : "any" });
			} })
		]));

		body.appendChild(section("Listen & Earn", [
			note("Listener ban kar baat karo. Har paid chat par max " + number(state.listenerMax) + " credits (≈ " + rupees(state.listenerMaxPaise) + ") milte hain, sirf asli replies par. Ye kamaai users ke asli kharch se aati hai. Hold " + state.holdDays + " din ka fixed hai, apne aap khulta hai, refer ya recharge se kuch nahi judta."),
			h("button", { class: listening ? "wallet-secondary" : "wallet-primary", type: "button", text: listening ? "Listening band karo" : "Listening shuru karo", onclick: function () {
				send({ type: listening ? "listen-stop" : "listen-start" });
				dialog.close();
			} })
		]));

		var packs = h("div", { class: "wallet-packs" });
		state.packs.forEach(function (pack) {
			packs.appendChild(h("button", { class: "wallet-pack", type: "button", disabled: state.payments ? null : "disabled", onclick: function () {
				send({ type: "wallet-recharge", pack: pack.id });
			} }, [h("strong", { text: "₹" + pack.rupees }), h("span", { text: number(pack.credits) + " credits" })]));
		});
		body.appendChild(section("Recharge", [packs, note(state.payments ? "Kharide hue credits sirf chat me kharch hote hain, withdraw nahi hote." : "Payments abhi chalu nahi hain.")]));

		var upi = h("input", { type: "text", maxlength: "80", placeholder: "yourname@upi", autocomplete: "off" });
		body.appendChild(section("Withdraw", [
			note("Minimum ₹" + state.minWithdrawRupees + ". Sirf hold khul chuki kamaai nikalti hai. Owner UPI par bhejta hai."),
			h("div", { class: "wallet-row" }, [upi, h("button", { class: "wallet-secondary", type: "button", text: "Withdraw", onclick: function () {
				send({ type: "wallet-withdraw", upi: upi.value.trim() });
			} })])
		]));

		var codeInput = h("input", { type: "text", maxlength: "16", placeholder: "Referral code", autocomplete: "off" });
		var referralNodes = [note("Aapka code: " + state.code + ". Dost ke pehle recharge par aapko " + 400 + " aur use " + 300 + " credits milte hain (sirf chat credits).")];
		if (!state.hasReferrer) {
			referralNodes.push(h("div", { class: "wallet-row" }, [codeInput, h("button", { class: "wallet-secondary", type: "button", text: "Lagao", onclick: function () {
				send({ type: "wallet-referral", code: codeInput.value.trim() });
			} })]));
		}
		body.appendChild(section("Referral", referralNodes));
		body.appendChild(note("AI chat hamesha free hai aur uska koi payout nahi hota."));
	}

	function ensureUi() {
		if (dialog) return;
		var header = document.querySelector(".header-actions");
		openButton = h("button", { class: "small-action", id: "wallet-open", type: "button", text: "Wallet", onclick: function () {
			requestState();
			render();
			if (!dialog.open) dialog.showModal();
		} });
		if (header) header.insertBefore(openButton, header.firstChild);

		dialog = h("dialog", { class: "wallet-dialog", id: "wallet-dialog" }, [
			h("div", { class: "wallet-head" }, [
				h("h2", { text: "Wallet" }),
				h("button", { class: "wallet-close", type: "button", "aria-label": "Close", text: "×", onclick: function () { dialog.close(); } })
			]),
			h("div", { class: "wallet-body" })
		]);
		document.body.appendChild(dialog);

		banner = h("div", { class: "paid-banner", hidden: "hidden" });
		var chatHeader = document.querySelector(".chat-header");
		if (chatHeader && chatHeader.parentNode) chatHeader.parentNode.insertBefore(banner, chatHeader.nextSibling);
	}

	function updateOpenButton() {
		if (openButton) openButton.textContent = listening ? "Wallet · Listening" : "Wallet";
	}

	function hideBanner() {
		clearInterval(bannerTimer);
		bannerTimer = null;
		if (banner) {
			banner.hidden = true;
			banner.textContent = "";
		}
	}

	function startBanner(match) {
		ensureUi();
		function tick() {
			var left = Math.max(0, Math.round((match.endsAt - Date.now()) / 1000));
			var clock = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
			banner.textContent = match.role === "listener"
				? "Paid chat · " + clock + " baaki · asli replies par max " + number(match.maxEarn) + " credits kamaoge"
				: "Paid chat · " + clock + " baaki · " + number(match.cost) + " credits (reply na mile to wapas)";
			if (left <= 0) hideBanner();
		}
		hideBanner();
		banner.hidden = false;
		tick();
		bannerTimer = setInterval(tick, 1000);
	}

	function handleSettled(message) {
		if (message.role === "seeker") {
			toast(message.refunded ? "Samne wale ne reply nahi diya, aapke credits wapas ho gaye." : number(message.charged) + " credits is chat me lage.");
		} else if (message.earnedCredits > 0) {
			toast("Aapne " + rupees(message.earnedPaise) + " kamaye. " + message.holdDays + " din baad withdraw ke liye khulenge.");
		} else {
			toast("Is chat me kamaai nahi hui (asli replies kam the).");
		}
		if (dialog && dialog.open) requestState();
	}

	// script.js is function ko har server message par sabse pehle bulata hai. true = maine handle kar liya.
	window.walletOnMessage = function (message) {
		ensureUi();
		switch (message.type) {
			case "profile-saved":
				setTimeout(requestState, 0);
				return false;
			case "wallet-state":
				state = message;
				listening = Boolean(message.listening);
				updateOpenButton();
				render();
				return true;
			case "wallet-order":
				openCheckout(message);
				return true;
			case "wallet-notice":
			case "wallet-error":
				toast(message.message);
				return true;
			case "listening":
				listening = Boolean(message.on);
				updateOpenButton();
				render();
				if (listening) toast("Listening ON. Koi paid chat ke liye aayega to match ho jayega.");
				return true;
			case "paid-match":
				startBanner(message);
				return true;
			case "paid-timeout":
				toast("Time poora hua, chat khatam.");
				hideBanner();
				return true;
			case "paid-settled":
				handleSettled(message);
				hideBanner();
				return true;
			case "partner-left":
			case "private-left":
				hideBanner();
				return false;
			default:
				return false;
		}
	};

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ensureUi);
	else ensureUi();

	// script.js ko chhue bina server ke messages sunne ke liye: WebSocket ko lapet do.
	// (Ye file script.js se pehle load hoti hai, isliye har naya socket yahin se guzarta hai.)
	var NativeSocket = window.WebSocket;
	function WalletSocket(url, protocols) {
		var socket = protocols === undefined ? new NativeSocket(url) : new NativeSocket(url, protocols);
		socket.addEventListener("message", function (event) {
			var message;
			try { message = JSON.parse(event.data); } catch (error) { return; }
			var run = function () {
				try { window.walletOnMessage(message); } catch (error) { console.error("wallet ui:", error); }
			};
			if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
			else run();
		});
		return socket;
	}
	WalletSocket.prototype = NativeSocket.prototype;
	["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (name) { WalletSocket[name] = NativeSocket[name]; });
	window.WebSocket = WalletSocket;
})();
