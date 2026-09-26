// RSS 2.0 / RSS 1.0 (RDF) / Atom から記事を読む。依存を増やさないため、必要な要素だけを正規表現で拾う

export type FeedItem = {
	title: string;
	url: string;
	/** 概要。無ければ null */
	summary: string | null;
	/** 公開時刻。無いか読めなければ null */
	publishedAt: number | null;
};

/** 概要はこの文字数で切る（採点に渡す量と保存量を抑えるため） */
export const SUMMARY_MAX = 500;

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
		if (e[0] === "#") {
			const code =
				e[1] === "x" || e[1] === "X"
					? Number.parseInt(e.slice(2), 16)
					: Number.parseInt(e.slice(1), 10);
			return Number.isFinite(code) && code <= 0x10ffff
				? String.fromCodePoint(code)
				: m;
		}
		return ENTITIES[e.toLowerCase()] ?? m;
	});
}

/** 要素の中身を文字列にする。CDATA を外し、HTML のタグを除き、実体参照を戻して空白を詰める */
function text(raw: string): string {
	const unwrapped = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
	// 概要の中の HTML はエスケープされていることが多いので、戻してからタグを除く
	const decoded = decodeEntities(unwrapped);
	return decodeEntities(decoded.replace(/<[^>]*>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 最初に見つかった要素の中身（生のまま）。自己終了タグなら空文字 */
function inner(xml: string, tag: string): string | null {
	const t = escapeRe(tag);
	const m = new RegExp(
		`<${t}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${t}\\s*>)`,
		"i",
	).exec(xml);
	return m ? (m[1] ?? "") : null;
}

function attr(xml: string, tag: string, name: string, rel?: string) {
	const re = new RegExp(`<${escapeRe(tag)}\\s([^>]*)>`, "gi");
	for (const m of xml.matchAll(re)) {
		const attrs = m[1] as string;
		const get = (n: string) =>
			new RegExp(`\\b${n}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(attrs);
		const r = get("rel");
		const relValue = r ? (r[2] ?? r[3]) : "alternate";
		if (rel && relValue !== rel) continue;
		const v = get(name);
		if (v) return decodeEntities((v[2] ?? v[3]) as string);
	}
	return null;
}

function parseTime(s: string | null): number | null {
	if (!s) return null;
	const t = Date.parse(text(s));
	return Number.isFinite(t) ? t : null;
}

function first(xml: string, tags: string[]): string | null {
	for (const tag of tags) {
		const v = inner(xml, tag);
		if (v !== null && text(v) !== "") return v;
	}
	return null;
}

function parseItem(xml: string): FeedItem | null {
	const title = text(first(xml, ["title"]) ?? "");
	const link = first(xml, ["link"]);
	const url =
		(link !== null && text(link)) ||
		attr(xml, "link", "href", "alternate") ||
		text(first(xml, ["guid", "id"]) ?? "");
	if (!title || !/^https?:\/\//i.test(url)) return null;
	const rawSummary = first(xml, ["description", "summary", "content"]);
	let summary = rawSummary === null ? null : text(rawSummary);
	if (summary === "") summary = null;
	if (summary !== null && summary.length > SUMMARY_MAX) {
		summary = `${summary.slice(0, SUMMARY_MAX)}…`;
	}
	return {
		title,
		url,
		summary,
		publishedAt: parseTime(
			first(xml, ["pubDate", "published", "dc:date", "updated"]),
		),
	};
}

/** 記事の一覧。RSS / Atom と読めなければ例外 */
export function parseFeed(xml: string): FeedItem[] {
	const blocks = [
		...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi),
	];
	if (blocks.length === 0 && !/<(rss|feed|rdf:RDF)[\s>]/i.test(xml)) {
		throw new Error("RSS / Atom として読めない");
	}
	return blocks
		.map((m) => parseItem(m[2] as string))
		.filter((i): i is FeedItem => i !== null);
}
