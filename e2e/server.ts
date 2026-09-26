// E2E 用に、空のテスト用 DB で backend を起動する
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../.e2e-data", import.meta.url));
rmSync(dir, { recursive: true, force: true });
process.env.DB_PATH = `${dir}/test.db`;
process.env.HOST = "127.0.0.1";
await import("../packages/backend/src/main");
