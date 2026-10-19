// Render isi file ko chalata hai (package.json me "start": "node start.js").
// Ye server.js ko memory me padhkar wallet ke chhote hooks jodta hai, phir chalata hai.
// Aapki server.js, index.html, script.js, style.css me koi badlav nahi karna padta.
// Agar kuch bhi galat ho jaye to ye purani server.js ko bina wallet ke chala deta hai (site band nahi hoti).
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const dir = fileURLToPath(new URL(".", import.meta.url));

const edits = [
	{
		marker: "createWallet",
		find: 'import { WebSocket, WebSocketServer } from "ws";',
		replace: 'import { WebSocket, WebSocketServer } from "ws";\nimport { createWallet } from "./wallet.js";'
	},
	{
		marker: "wallet-client.js",
		find: '"config.js", "favicon.svg"',
		replace: '"config.js", "wallet-client.js", "wallet.css", "favicon.svg"'
	},
	{
		marker: "wallet.dropFromQueues",
		find: "function removeFromQueue(socket) {",
		replace: "function removeFromQueue(socket) {\n\twallet.dropFromQueues(socket);"
	},
	{
		marker: "wallet.onChatEnd",
		find: "function endPrivateChat(socket) {",
		replace: "function endPrivateChat(socket) {\n\twallet.onChatEnd(socket);"
	},
	{
		marker: "const wallet = createWallet",
		find: "// ---------- Report / Block / Ban ----------",
		replace: "const wallet = createWallet({ send, clients, canMatch, connectGuests, endPrivateChat, removeFromQueue });\n\n// ---------- Report / Block / Ban ----------"
	},
	{
		marker: "wallet.handle",
		find: 'if (!payload || typeof payload !== "object" || typeof payload.type !== "string") return;',
		replace: 'if (!payload || typeof payload !== "object" || typeof payload.type !== "string") return;\n\tif (await wallet.handle(socket, payload)) return;'
	},
	{
		marker: "wallet.onPrivateText",
		find: 'rememberMessage(message, { scope: "private", contextId: socket.matchId, participantIds: [socket.userId, socket.peer.userId], senderIp: socket.ip });',
		replace: 'rememberMessage(message, { scope: "private", contextId: socket.matchId, participantIds: [socket.userId, socket.peer.userId], senderIp: socket.ip });\n\t\t\twallet.onPrivateText(socket, text);'
	},
	{
		marker: "wallet.http",
		find: 'if (pathname === "/health") {',
		replace: 'if (await wallet.http(request, response, pathname)) return;\n\tif (pathname === "/health") {'
	},
	{
		// index.html bhejte waqt wallet ki css aur js ke tag jod do (index.html file me kuch nahi badalta).
		marker: "wallet-inject",
		find: "response.end(content);",
		replace: 'response.end(fileName === "index.html" ? String(content).replace("</head>", \'<link rel="stylesheet" href="wallet.css"><script src="wallet-client.js"></script><!-- wallet-inject --></head>\') : content);'
	}
];

async function runOriginal(reason) {
	console.error(`WALLET NOT LOADED, plain server chal raha hai. Wajah: ${reason}`);
	await import("./server.js");
}

try {
	let source = await readFile(join(dir, "server.js"), "utf8");
	const missing = [];
	for (const edit of edits) {
		if (source.includes(edit.marker)) continue;
		if (source.split(edit.find).length - 1 !== 1) {
			missing.push(edit.find.slice(0, 70));
			continue;
		}
		source = source.replace(edit.find, () => edit.replace);
	}
	if (missing.length > 0) {
		await runOriginal(`server.js me ye line nahi mili: ${missing.join(" | ")}`);
	} else {
		const out = join(dir, "server.wallet.generated.js");
		await writeFile(out, source);
		try {
			await import("./server.wallet.generated.js");
			console.log("Wallet hooks loaded.");
		} catch (error) {
			await runOriginal(error.message);
		}
	}
} catch (error) {
	await runOriginal(error.message);
}
