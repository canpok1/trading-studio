import type { Candle, Gap, Instrument, Timeframe } from "@trading-studio/core";
import type { ImportJob, TimeframeCoverage } from "./types-domain";

export interface MarketDataRepository {
	/** 読み書きする足の銘柄 */
	readonly instrument: Instrument;
	createImport(timeframe: Timeframe, fileName: string, now: number): number;
	finishImport(job: ImportJob): void;
	/** サーバーが途中で止まった取り込みを失敗として残す */
	failInterrupted(now: number): number;
	getImport(id: number): ImportJob | null;
	listImports(limit?: number): ImportJob[];
	/**
	 * 取り込んだ足を保存する。同じ粒度・同じ日時に自動で作った足しか無ければ、取り込んだ足で置き換える。
	 * 取り込んだ・収集した足があれば、overwrite なら上書きし、そうでなければ保存しない（件数に数える）
	 */
	insertImported(
		timeframe: Timeframe,
		rows: readonly Candle[],
		importId: number,
		{
			overwrite,
		}?: {
			overwrite?: boolean;
		},
	): {
		inserted: number;
		skipped: number;
	};
	/** 足（古い順）のうち、同じ粒度・同じ日時に取り込んだ・収集した足があるもの。無ければ null */
	overlap(
		timeframe: Timeframe,
		rows: readonly Candle[],
	): {
		from: number;
		to: number;
		count: number;
	} | null;
	/** 取り込みを取り消す。その取り込みで保存した足を消す */
	deleteImported(importId: number): void;
	/** [from, to) のその粒度の足を最大 limit 本消し、消した本数を返す */
	deleteCandles(
		timeframe: Timeframe,
		from: number,
		to: number,
		limit: number,
	): number;
	loadCandles(timeframe: Timeframe, from: number, to: number): Candle[];
	/** 書き出す期間 [from, to) の足を古い順に最大 limit 本。少しずつ読むのに使う */
	loadExportPage(
		timeframe: Timeframe,
		from: number,
		to: number,
		limit: number,
	): Candle[];
	/** 書き出す期間 [from, to) の足の最初と最後の開始時刻。足が無ければ null */
	exportRange(
		timeframe: Timeframe,
		from: number,
		to: number,
	): {
		first: number;
		last: number;
	} | null;
	/**
	 * 期間 [from, to) の粗い粒度の足を、1段細かい粒度の足から作り直す（1分→5分→15分→1時間→4時間→日足）。
	 * 取り込んだ足は上書きせず、足が無い日時と自動で作った足だけを埋める。作った足の数を返す。
	 * overrideImported なら、細かい足が1本も欠けずに揃っている区切りに限り、取り込んだ足も上書きする
	 * （収集した足を正とするため。欠けている区切りで上書きすると、完全な足を不完全な足で置き換えてしまう）
	 * importId が null なら、足に付いている取り込みを残す（取り込みを中止したときに、その取り込みから作った足を消せるように）
	 */
	refillDerived(
		from: number,
		to: number,
		importId: number | null,
		{
			overrideImported,
		}?: {
			overrideImported?: boolean;
		},
	): number;
	/** 収集した1分足を保存する。同じ日時の足は出どころを問わず上書きする（収集した足を正とする） */
	upsertCollected(rows: readonly Candle[]): void;
	/**
	 * 期間内に取り込んだ・収集した（自動で作っていない）足がある粒度（細かい順）。
	 * 期間内のデータのある範囲の一部にしか無い粒度は除く（例: 数年分の1時間足に、収集した直近の1分足だけが重なる場合の1分足）。
	 * 除かないと、細かい足で判定するバックテストが、その粒度の足がある一部の期間だけで進んでしまう。
	 * 端は1日までずれてよい（日足は JST 0:00 始まりのため、同じ日のデータでも開始時刻が揃わない）
	 */
	importedTimeframes(from: number, to: number): Timeframe[];
	/** その粒度の最も古い足の開始時刻。足が無ければ null */
	firstCandleTime(timeframe: Timeframe): number | null;
	lastCandle(timeframe: Timeframe): Candle | null;
	/** 開始時刻が time 以下で最も新しい足 */
	lastCandleAtOrBefore(timeframe: Timeframe, time: number): Candle | null;
	/** 開始時刻が before より前の足を、新しい方から count 本（古い順に並べて返す） */
	candlesBefore(timeframe: Timeframe, before: number, count: number): Candle[];
	countCandles(timeframe: Timeframe, from: number, to: number): number;
	/** 取り込み済みの足のうち、最後に確定した足の終値。足が無ければ null */
	latestClose(): {
		time: number;
		close: number;
	} | null;
	coverage(): TimeframeCoverage[];
	/** 欠損の区間。足の開始時刻の差が1本より長いところ */
	gaps(timeframe: Timeframe, from?: number, to?: number): Gap[];
}
