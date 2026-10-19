// Supabase REST ke upar wallet store. Koi naya npm package nahi chahiye (sirf fetch).
// Render Environment: SUPABASE_URL, SUPABASE_SERVICE_KEY (service_role key, kabhi browser me mat daalna).

const BASE = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const KEY = (process.env.SUPABASE_SERVICE_KEY || "").trim();

export const storeEnabled = Boolean(BASE && KEY);

async function call(path, { method = "GET", body, headers = {} } = {}) {
	const response = await fetch(`${BASE}${path}`, {
		method,
		headers: { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json", ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(10000)
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`Supabase ${response.status}: ${text.slice(0, 300)}`);
	return { data: text ? JSON.parse(text) : null, headers: response.headers };
}

async function rpc(name, args) {
	return (await call(`/rest/v1/rpc/${name}`, { method: "POST", body: args })).data;
}

export const getWallet = (uid) => rpc("wallet_get", { p_uid: uid });
export const applyDelta = (uid, credits, earn, kind, ref) =>
	rpc("wallet_apply", { p_uid: uid, p_credits: credits, p_earn: earn, p_kind: kind, p_ref: String(ref) });
export const addLot = (uid, credits, availableAtIso, ref) =>
	rpc("earn_lot_add", { p_uid: uid, p_credits: credits, p_available: availableAtIso, p_ref: String(ref) });
export const rechargeCredit = (orderId, paymentId) => rpc("recharge_credit", { p_order: orderId, p_payment: paymentId });
export const requestWithdrawal = (uid, upi, minPaise) => rpc("withdraw_request", { p_uid: uid, p_upi: upi, p_min_paise: minPaise });
export const resolveWithdrawal = (id, action, note) => rpc("withdraw_resolve", { p_id: Number(id), p_action: action, p_note: note || null });
export const setReferral = (uid, code) => rpc("referral_set", { p_uid: uid, p_code: code });
export const claimReferral = (uid) => rpc("referral_claim", { p_uid: uid });

export async function insertRecharge(row) {
	await call("/rest/v1/recharges", { method: "POST", body: row, headers: { prefer: "return=minimal" } });
}

export async function getRecharge(orderId) {
	const { data } = await call(`/rest/v1/recharges?order_id=eq.${encodeURIComponent(orderId)}&select=*`);
	return Array.isArray(data) && data[0] ? data[0] : null;
}

export async function listWithdrawals(status) {
	const filter = status ? `status=eq.${encodeURIComponent(status)}&` : "";
	const { data } = await call(`/rest/v1/withdrawals?${filter}select=*&order=id.asc&limit=200`);
	return Array.isArray(data) ? data : [];
}

// Kitni baar ye kind ledger me aaya (signup bonus ki limit ke liye).
export async function countKind(kind) {
	const { headers } = await call(`/rest/v1/ledger?kind=eq.${encodeURIComponent(kind)}&select=id`, {
		headers: { prefer: "count=exact", range: "0-0" }
	});
	const total = String(headers.get("content-range") || "").split("/")[1];
	return Number.isFinite(Number(total)) ? Number(total) : 0;
}
