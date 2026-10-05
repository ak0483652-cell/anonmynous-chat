import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
const publishDirectory = join(projectDirectory, "netlify");
const websocketUrl = process.env.STRANGELY_WS_URL?.trim() || "wss://YOUR-RENDER-SERVICE.onrender.com/ws";

if (process.env.STRANGELY_WS_URL) {
	const parsedUrl = new URL(websocketUrl);
	if (parsedUrl.protocol !== "wss:" || parsedUrl.pathname !== "/ws") {
		throw new Error("STRANGELY_WS_URL must be a secure WebSocket URL ending in /ws.");
	}
}

await mkdir(publishDirectory, { recursive: true });
await Promise.all(["index.html", "script.js", "style.css"].map((file) => copyFile(join(projectDirectory, file), join(publishDirectory, file))));
await writeFile(join(publishDirectory, "config.js"), `window.STRANGELY_WS_URL = ${JSON.stringify(websocketUrl)};\n`, "utf8");

console.log(`Netlify files prepared in ${publishDirectory}`);
if (!process.env.STRANGELY_WS_URL) {
	console.log("Replace YOUR-RENDER-SERVICE with the Render service host, or set STRANGELY_WS_URL before building.");
}
