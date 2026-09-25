import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { app } from "./app";
import { serveFrontend } from "./static";

const hostname = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const distDir =
	process.env.STATIC_DIR ??
	fileURLToPath(new URL("../../frontend/dist", import.meta.url));

const server = new Hono().route("/", app);
serveFrontend(server, distDir);

Bun.serve({ hostname, port, fetch: server.fetch });
console.log(`listening on http://${hostname}:${port}`);
