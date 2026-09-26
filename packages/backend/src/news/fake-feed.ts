// E2E 用。RSS の取得元へつながず、取得元の URL ごとに決まった形の記事を返す

import type { FetchFeed } from "./collector";

const HOUR = 3_600_000;

function escapeXml(s: string): string {
	return s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * 1時間ごとに1件ずつ記事が増える取得元を装う。直近3件を返すので、収集のたびに重複が混ざる。
 * isDown が true の間は失敗する
 */
export function demoFetchFeed({
	now = Date.now,
	isDown = () => false,
}: {
	now?: () => number;
	isDown?: () => boolean;
} = {}): FetchFeed {
	return async (url) => {
		if (isDown()) throw new Error("偽物の取得元が止まっている（E2E）");
		const latest = Math.floor(now() / HOUR);
		const items = [0, 1, 2].map((k) => {
			const hour = latest - k;
			const link = `${url.replace(/\/+$/, "")}/demo-${hour}`;
			return `<item><title>${escapeXml(`デモ記事 ${hour}（${url}）`)}</title><link>${escapeXml(link)}</link><description>デモの概要</description><pubDate>${new Date(hour * HOUR).toUTCString()}</pubDate></item>`;
		});
		return `<?xml version="1.0"?><rss version="2.0"><channel><title>demo</title>${items.join("")}</channel></rss>`;
	};
}
