// Usage (repo ke root me): node apply-wallet-patch.mjs
// server.js me wallet ke liye zaroori badlaav kar deta hai (pehle server.js.bak banata hai).
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";

const file = "server.js";
let code = readFileSync(file, "utf8");
const edits = [
	['import { createReelsApi } from "./reels-api.js";',
	 'import { createReelsApi } from "./reels-api.js";\nimport { createWallet, COSTS, walletEnabled, canAffordChat } from "./wallet.js";'],
	['const clients = new Set();',
	 'const clients = new Set();\nconst wallet = createWallet({ clients, send });'],
	['googleEnabled: Boolean(FIREBASE_PROJECT_ID) });',
	 'googleEnabled: Boolean(FIREBASE_PROJECT_ID), walletEnabled, chatCost: COSTS.chat });'],
	['socket.uid = null;',
	 'socket.uid = null;\n\tsocket.credits = 0;\n\tsocket.referralCode = null;\n\tsocket.pendingReferral = false;'],
	['socket.isAdmin = Boolean(account.email && ADMIN_EMAILS.has(account.email));',
	 'socket.isAdmin = Boolean(account.email && ADMIN_EMAILS.has(account.email));\n\t\t\tawait wallet.loginWallet(socket, account, payload.ref);'],
	['&& acceptsGender(second, first.profile.gender);',
	 '&& acceptsGender(second, first.profile.gender) && canAffordChat(first, second);'],
	['second.humanMatches += 1;',
	 'second.humanMatches += 1;\n\twallet.claimReferral(first);\n\twallet.claimReferral(second);'],
	['waitingGuests.push(socket);',
	 'if (wallet.blockWomenQueue(socket)) return;\n\twaitingGuests.push(socket);'],
	['const peer = socket.peer;',
	 'const peer = socket.peer;\n\twallet.chargeForChat(socket, peer);'],
	['first.humanMatches += 1;',
	 'first.humanMatches += 1;\n\tfirst.matchMessages = 0;\n\tsecond.matchMessages = 0;'],
	['send(socket.peer, personalizeMessage(message, socket.peer.userId));',
	 'socket.matchMessages = (socket.matchMessages || 0) + 1;\n\t\t\tsend(socket.peer, personalizeMessage(message, socket.peer.userId));'],
	['"apple-touch-icon.png"];',
	 '"apple-touch-icon.png", "wallet-dashboard.js"];'],
	['if (payload.type === "reaction") {',
	 'if (payload.type === "get-wallet") {\n\t\tawait wallet.handleGetWallet(socket);\n\t\treturn;\n\t}\n\n\tif (payload.type === "reaction") {'],
	['if (payload.type === "edit-message") {',
	 'if (payload.type === "reel-watched") {\n\t\tawait wallet.handleReelWatched(socket, payload);\n\t\treturn;\n\t}\n\n\tif (payload.type === "edit-message") {']
];

// Jo badlaav pehle se lag chuka hai use chhod do (script dobara chalana safe hai).
const pending = edits.filter(([, replacement]) => !code.includes(replacement));
if (pending.length === 0) {
	console.log("Sab badlaav pehle se lage hue hain.");
	process.exit(0);
}
for (const [anchor] of pending) {
	const count = code.split(anchor).length - 1;
	if (count !== 1) {
		console.error(`Patch roka: ye line ${count} baar mili (1 honi chahiye):\n  ${anchor}`);
		process.exit(1);
	}
}
copyFileSync(file, `${file}.bak`);
for (const [anchor, replacement] of pending) code = code.replace(anchor, () => replacement);
writeFileSync(file, code);
console.log(`Done: ${pending.length} badlaav lag gaye. Backup: ${file}.bak`);
