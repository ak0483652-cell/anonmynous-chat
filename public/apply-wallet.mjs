// Ek baar chalao:  node apply-wallet.mjs
// Ye aapke server.js, script.js aur index.html me wallet ke chhote hooks jodta hai.
// Pehle har file ki .bak copy banta hai. Dobara chalane par jo ho chuka hai wo skip hota hai.
// Agar koi jagah nahi mili to kuch bhi nahi badalta aur batata hai kaunsi line nahi mili.
import { readFile, writeFile, copyFile, access } from "node:fs/promises";

const edits = [
	{
		file: "server.js", marker: "createWallet",
		find: 'import { WebSocket, WebSocketServer } from "ws";',
		replace: 'import { WebSocket, WebSocketServer } from "ws";\nimport { createWallet } from "./wallet.js";'
	},
	{
		file: "server.js", marker: "wallet-client.js",
		find: '"config.js", "favicon.svg"',
		replace: '"config.js", "wallet-client.js", "wallet.css", "favicon.svg"'
	},
	{
		file: "server.js", marker: "wallet.dropFromQueues",
		find: "function removeFromQueue(socket) {",
		replace: "function removeFromQueue(socket) {\n\twallet.dropFromQueues(socket);"
	},
	{
		file: "server.js", marker: "wallet.onChatEnd",
		find: "function endPrivateChat(socket) {",
		replace: "function endPrivateChat(socket) {\n\twallet.onChatEnd(socket);"
	},
	{
		file: "server.js", marker: "const wallet = createWallet",
		find: "// ---------- Report / Block / Ban ----------",
		replace: "const wallet = createWallet({ send, clients, canMatch, connectGuests, endPrivateChat, removeFromQueue });\n\n// ---------- Report / Block / Ban ----------"
	},
	{
		file: "server.js", marker: "wallet.handle",
		find: 'if (!payload || typeof payload !== "object" || typeof payload.type !== "string") return;',
		replace: 'if (!payload || typeof payload !== "object" || typeof payload.type !== "string") return;\n\tif (await wallet.handle(socket, payload)) return;'
	},
	{
		file: "server.js", marker: "wallet.onPrivateText",
		find: 'rememberMessage(message, { scope: "private", contextId: socket.matchId, participantIds: [socket.userId, socket.peer.userId], senderIp: socket.ip });',
		replace: 'rememberMessage(message, { scope: "private", contextId: socket.matchId, participantIds: [socket.userId, socket.peer.userId], senderIp: socket.ip });\n\t\t\twallet.onPrivateText(socket, text);'
	},
	{
		file: "server.js", marker: "wallet.http",
		find: 'if (pathname === "/health") {',
		replace: 'if (await wallet.http(request, response, pathname)) return;\n\tif (pathname === "/health") {'
	},
	{
		file: "script.js", marker: "walletOnMessage",
		find: 'if (message.type === "active-count") {',
		replace: 'if (window.walletOnMessage && window.walletOnMessage(message)) return;\n\t\tif (message.type === "active-count") {'
	},
	{
		file: "index.html", marker: "wallet.css",
		find: '<link rel="stylesheet" href="style.css">',
		replace: '<link rel="stylesheet" href="style.css">\n    <link rel="stylesheet" href="wallet.css">'
	},
	{
		file: "index.html", marker: "wallet-client.js",
		find: '<script src="script.js" defer></script>',
		replace: '<script src="script.js" defer></script>\n    <script src="wallet-client.js" defer></script>'
	}
];

const contents = new Map();
const problems = [];
let changed = 0;
let skipped = 0;

for (const edit of edits) {
	if (!contents.has(edit.file)) {
		try {
			contents.set(edit.file, await readFile(edit.file, "utf8"));
		} catch {
			problems.push(`${edit.file}: file is folder me nahi mili (is script ko apne project folder me chalao).`);
			contents.set(edit.file, null);
		}
	}
	const text = contents.get(edit.file);
	if (text === null) continue;
	if (text.includes(edit.marker)) {
		skipped += 1;
		continue;
	}
	const occurrences = text.split(edit.find).length - 1;
	if (occurrences !== 1) {
		problems.push(`${edit.file}: ye line ${occurrences === 0 ? "nahi mili" : "kai jagah mili"}: ${edit.find.slice(0, 80)}`);
		continue;
	}
	contents.set(edit.file, text.replace(edit.find, () => edit.replace));
	changed += 1;
}

if (problems.length > 0) {
	console.error("Kuch nahi badla. In jagahon par dikkat hai:\n- " + problems.join("\n- "));
	process.exit(1);
}

for (const [file, text] of contents) {
	if (text === null) continue;
	try {
		await access(`${file}.bak`);
	} catch {
		await copyFile(file, `${file}.bak`);
	}
	await writeFile(file, text);
}
console.log(`Done. ${changed} badlav lage, ${skipped} pehle se lage the. Purani files .bak naam se bachi hain.`);
