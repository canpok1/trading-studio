import { resolve, sep } from "node:path";
import type { Hono } from "hono";

// 画面のビルド成果物を配信する。/api 以外で該当ファイルが無いパスには index.html を返す（画面側で遷移を扱うため）
export function serveFrontend(app: Hono, distDir: string): void {
	const root = resolve(distDir);
	app.get("*", async (c) => {
		const path = c.req.path;
		if (path === "/api" || path.startsWith("/api/")) {
			return c.notFound();
		}
		// c.req.path は Hono がデコード済み。ここで再びデコードすると %2f が / に化けて配信ディレクトリの外を指せるため、そのまま使う
		const target = resolve(root, `.${path}`);
		if (target.startsWith(root + sep)) {
			const file = Bun.file(target);
			if (await file.exists()) {
				return new Response(file);
			}
		}
		const index = Bun.file(resolve(root, "index.html"));
		if (!(await index.exists())) {
			return c.text("画面がビルドされていない。bun run build を実行する", 404);
		}
		return new Response(index);
	});
}
