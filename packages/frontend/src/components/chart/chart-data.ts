// チャートに渡すデータの変換。描画ライブラリに依存しない部分をここに置き、単体テストする

import type { Side } from "@trading-studio/core";
import { JST_OFFSET_MS } from "@trading-studio/core";

export type ChartBar = { time: number; close: number };

export type ChartMarkerStatus = "open" | "filled" | "canceled";

/** チャートに出す注文。time は注文・約定・取消の時刻（エポックミリ秒） */
export type ChartMarker = {
	id: string;
	time: number;
	side: Side;
	status: ChartMarkerStatus;
	price: number;
};

export type ChartRange = "1d" | "1w" | "1m" | "all";

export const CHART_RANGES: readonly (readonly [ChartRange, string])[] = [
	["1d", "1日"],
	["1w", "1週"],
	["1m", "1か月"],
	["all", "全期間"],
];

const RANGE_MS: Record<Exclude<ChartRange, "all">, number> = {
	"1d": 86_400_000,
	"1w": 7 * 86_400_000,
	"1m": 30 * 86_400_000,
};

/**
 * 描画ライブラリの時刻（秒）。ライブラリは時刻を UTC として目盛りを振るので、
 * JST の日付の区切りで目盛りが出るよう 9 時間ずらして渡す
 */
export function toChartTime(ms: number): number {
	return (ms + JST_OFFSET_MS) / 1000;
}

export function fromChartTime(t: number): number {
	return t * 1000 - JST_OFFSET_MS;
}

/**
 * 描画の枠。bar は足の番号（bars の添字）で、足の無い枠は null。
 * 描画ライブラリは横軸を時刻ではなく並び順で決めるので、欠損している期間に空の枠を挟んで時間軸を保つ
 */
export type ChartSlot = { time: number; bar: number | null };

/** 空の枠を含めた枠の数の上限。超えるときは欠損の空白を縮めて収める */
export const MAX_CHART_SLOTS = 100_000;

/** 足の間隔。隣り合う足の時刻の差の最小値。足が2本未満なら null */
export function barStep(times: readonly number[]): number | null {
	let step: number | null = null;
	for (let i = 1; i < times.length; i++) {
		const d = (times[i] as number) - (times[i - 1] as number);
		if (d > 0 && (step === null || d < step)) step = d;
	}
	return step;
}

/** 足の間に、欠損している足の数だけ空の枠を挟む */
export function toSlots(
	times: readonly number[],
	maxSlots = MAX_CHART_SLOTS,
): ChartSlot[] {
	const step = barStep(times);
	if (step === null) return times.map((time, i) => ({ time, bar: i }));
	const missing = times.map((t, i) =>
		i === 0 ? 0 : Math.ceil((t - (times[i - 1] as number)) / step) - 1,
	);
	const total = missing.reduce((a, b) => a + b, 0);
	const room = Math.max(0, maxSlots - times.length);
	const scale = total > room ? room / total : 1;
	const slots: ChartSlot[] = [];
	times.forEach((t, i) => {
		const n = missing[i] as number;
		if (n > 0) {
			const prev = times[i - 1] as number;
			if (scale === 1) {
				for (let j = 1; j <= n; j++)
					slots.push({ time: prev + j * step, bar: null });
			} else {
				// 縮めても空白は残す（1枠以上）
				const k = Math.max(1, Math.floor(n * scale));
				for (let j = 1; j <= k; j++) {
					slots.push({
						time: prev + Math.round(((t - prev) * j) / (k + 1)),
						bar: null,
					});
				}
			}
		}
		slots.push({ time: t, bar: i });
	});
	return slots;
}

/** 注文の時刻を、その時刻を含む足（開始時刻が time 以下で最も遅い足）の開始時刻に合わせる。足より前なら null */
export function snapToBar(
	barTimes: readonly number[],
	time: number,
): number | null {
	let lo = 0;
	let hi = barTimes.length - 1;
	let found: number | null = null;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const t = barTimes[mid] as number;
		if (t <= time) {
			found = t;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return found;
}

/** アイコンの形。注文=円、約定=上下の矢印、取消=四角 */
export function markerShape(
	m: Pick<ChartMarker, "side" | "status">,
): "arrowUp" | "arrowDown" | "circle" | "square" {
	if (m.status === "filled") return m.side === "buy" ? "arrowUp" : "arrowDown";
	return m.status === "open" ? "circle" : "square";
}

/** アイコンの色の CSS 変数 */
export function markerColorVar(
	m: Pick<ChartMarker, "side" | "status">,
): string {
	if (m.status === "canceled") return "--color-cancel";
	return m.side === "buy" ? "--color-buy" : "--color-sell";
}

/**
 * 表示期間に合わせた論理範囲（足の番号）。足が無ければ null（全体を収める）。
 * 全期間は左に余白を空ける。最初の足がチャートの左端に来ると、その目盛りの文字が途中で切れるため
 */
export function visibleRange(
	range: ChartRange,
	barCount: number,
	stepMs: number,
): { from: number; to: number } | null {
	if (barCount === 0) return null;
	if (range === "all") {
		return { from: -Math.ceil(barCount * 0.1), to: barCount - 1 + 3 };
	}
	const k = Math.max(5, Math.round(RANGE_MS[range] / stepMs));
	return { from: barCount - k - 0.5, to: barCount - 1 + 3 };
}
