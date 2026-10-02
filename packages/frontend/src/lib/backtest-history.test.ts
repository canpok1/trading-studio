import { expect, test } from "bun:test";
import { parseRunFilter, runFilterParams, runQuery } from "./backtest-history";

test("URL との読み書きは往復で変わらず、既定の値は書かない", () => {
	const empty = parseRunFilter(new URLSearchParams("tab=history"));
	expect(empty).toEqual({ q: "", hideFailed: false, sort: "new" });
	expect(runFilterParams(empty).toString()).toBe("tab=history");
	const f = { q: "トレンド 改善版", hideFailed: true, sort: "pnl" as const };
	expect(parseRunFilter(runFilterParams(f))).toEqual(f);
	expect(parseRunFilter(new URLSearchParams("sort=x&hide=1"))).toEqual(empty);
});

test("API の問い合わせは既定の値を送らず、キーワードの前後の空白を除く", () => {
	expect(runQuery({ q: "  ", hideFailed: false, sort: "new" }, 20)).toEqual({
		limit: "20",
	});
	expect(
		runQuery({ q: " レンジ ", hideFailed: true, sort: "pnl" }, 40),
	).toEqual({ limit: "40", q: "レンジ", hideFailed: "1", sort: "pnl" });
});
