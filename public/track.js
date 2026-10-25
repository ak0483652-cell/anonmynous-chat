// Apni site ke har page mein <script src="track.js" defer></script> daalo (ya inline paste karo).
// Pehle API ka URL badlo.
(() => {
	const API = "https://YOUR-SERVER.onrender.com";
	try {
		if (sessionStorage.getItem("sr_hit")) return;
		sessionStorage.setItem("sr_hit", "1");
		let vid = localStorage.getItem("sr_vid");
		if (!vid) localStorage.setItem("sr_vid", (vid = crypto.randomUUID()));
		const q = new URLSearchParams(location.search);
		fetch(API + "/api/track", {
			method: "POST",
			headers: { "content-type": "application/json" },
			keepalive: true,
			body: JSON.stringify({
				vid, path: location.pathname, ref: document.referrer,
				utm: { source: q.get("utm_source"), medium: q.get("utm_medium"), campaign: q.get("utm_campaign") }
			})
		});
	} catch {}
})();
