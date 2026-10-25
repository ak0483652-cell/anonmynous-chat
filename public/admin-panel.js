// Admin-only traffic panel. index.html mein: <script src="admin-panel.js" defer></script>
// Button sirf tab dikhta hai jab server confirm kare ki Gmail admin hai.
// Token script.js ke window.strangelyAuth.getToken se aata hai. API URL config.js ke STRANGELY_WS_URL se nikalta hai.
(() => {
	const API = (window.STRANGELY_API || (window.STRANGELY_WS_URL || "").replace(/^ws/i, "http").replace(/\/ws\/?$/, "") || location.origin).replace(/\/+$/, "");
	const css = `.tp-btn{position:fixed;right:14px;bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:50;padding:9px 14px;border-radius:999px;border:0;background:#1f3a8a;color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}
.tp-dlg{width:min(560px,94vw);max-height:86vh;border:0;border-radius:14px;padding:18px;font:14px/1.5 system-ui,sans-serif;color:#1b2320;background:#fff}
.tp-dlg::backdrop{background:rgba(0,0,0,.45)}.tp-dlg h3{margin:0 0 4px;font-size:18px}.tp-dlg h4{margin:16px 0 6px;font-size:13px}
.tp-top{font-size:32px;font-weight:700;line-height:1.15}.tp-mute{color:#68736e;margin:0}
.tp-range{display:flex;gap:6px;margin:10px 0}.tp-range button,.tp-x{padding:6px 10px;border-radius:8px;border:1px solid #d5dbd6;background:#fff;cursor:pointer;font:inherit}
.tp-range .on{background:#1f3a8a;color:#fff;border-color:#1f3a8a}
.tp-row{display:grid;grid-template-columns:100px 1fr 44px;gap:8px;align-items:center;margin:4px 0}
.tp-row span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tp-row b{text-align:right;font-weight:600}
.tp-tr{background:#dbe4fb;border-radius:4px;height:9px}.tp-tr i{display:block;background:#1f3a8a;height:9px;border-radius:4px}`;
	const style = document.createElement("style");
	style.textContent = css;
	document.head.appendChild(style);

	const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
	async function token() {
		return (await window.strangelyAuth?.getToken?.()) || null;
	}
	async function fetchStats(days) {
		const t = await token();
		if (!t) return null;
		const r = await fetch(`${API}/api/analytics?days=${days}`, { headers: { authorization: "Bearer " + t } });
		return r.ok ? r.json() : null;
	}
	const rows = (list, key) => {
		const max = Math.max(1, ...list.map((x) => x.visits));
		return list.length ? list.map((x) => `<div class="tp-row"><span>${esc(x[key])}</span><div class="tp-tr"><i style="width:${(x.visits / max) * 100}%"></i></div><b>${x.visits}</b></div>`).join("") : '<p class="tp-mute">Abhi data nahi.</p>';
	};

	let btn, dlg, days = 7;
	function render(d) {
		const s = d.sources[0];
		dlg.innerHTML = `<h3>Traffic</h3><p class="tp-mute">Pichhle ${days} din</p>
<div class="tp-range">${[1, 7, 30].map((n) => `<button data-d="${n}" class="${n === days ? "on" : ""}">${n === 1 ? "Aaj" : n + " din"}</button>`).join("")}<button class="tp-x" data-close style="margin-left:auto">Close</button></div>
<div class="tp-top">${s ? esc(s.source) : "Abhi koi visit nahi"}</div>
<p class="tp-mute">${s ? `sabse zyada traffic yahin se (${s.visits}). ` : ""}Total ${d.visits} visits, ${d.visitors} unique.</p>
<h4>Sources</h4>${rows(d.sources, "source")}<h4>Countries</h4>${rows(d.countries, "country")}<h4>Devices</h4>${rows(d.devices, "device")}`;
	}
	async function open(d) {
		if (!dlg) {
			dlg = document.createElement("dialog");
			dlg.className = "tp-dlg";
			dlg.addEventListener("click", async (e) => {
				if (e.target === dlg || e.target.closest("[data-close]")) return dlg.close();
				const b = e.target.closest("[data-d]");
				if (!b) return;
				days = +b.dataset.d;
				const next = await fetchStats(days);
				if (next) render(next);
			});
			document.body.appendChild(dlg);
		}
		render(d);
		dlg.showModal();
	}
	async function check() {
		if (btn) return;
		const d = await fetchStats(days).catch(() => null);
		if (!d) return;
		btn = document.createElement("button");
		btn.className = "tp-btn";
		btn.textContent = "Traffic";
		btn.onclick = async () => open((await fetchStats(days)) || d);
		document.body.appendChild(btn);
	}
	// Login kabhi bhi ho sakta hai: 10 minute tak har 5 second mein, aur tab par wapas aane par bhi check karo.
	let tries = 0;
	const timer = setInterval(() => { check(); if (btn || ++tries > 120) clearInterval(timer); }, 5000);
	document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
	window.addEventListener("focus", check);
	check();
})();
