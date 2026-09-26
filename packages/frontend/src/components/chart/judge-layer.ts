// 価格チャートに AI 判定を重ねる描画拡張。背景に選んだ判定1つを薄く、残りをチャートの下の帯に濃く塗る

import type { Judge } from "@trading-studio/core";
import { JUDGE_LABELS } from "@trading-studio/core";
import type {
	IChartApi,
	IPrimitivePaneRenderer,
	IPrimitivePaneView,
	ISeriesPrimitive,
	SeriesAttachedParameter,
	Time,
} from "lightweight-charts";
import { valueStyle } from "../judgment/judgment-style";
import type { BarJudgments, JudgmentRun } from "./judgment-data";
import { judgmentRuns, stripJudges } from "./judgment-data";

type Target = Parameters<IPrimitivePaneRenderer["draw"]>[0];
type BitmapScope = Parameters<
	Parameters<Target["useBitmapCoordinateSpace"]>[0]
>[0];

function inBitmap(t: Target, draw: (scope: BitmapScope) => void) {
	// biome-ignore lint/correctness/useHookAtTopLevel: React のフックではなく描画ライブラリのメソッド
	t.useBitmapCoordinateSpace(draw);
}

export const STRIP_H = 14;
const STRIP_GAP = 3;
const STRIP_PAD = 4;

/** 帯の領域の高さ（px）。判定が無ければ 0 */
export function stripArea(hasJudgments: boolean): number {
	return hasJudgments ? 2 * (STRIP_H + STRIP_GAP) + STRIP_PAD : 0;
}

export class JudgeLayer implements ISeriesPrimitive<Time> {
	private chart: IChartApi | null = null;
	private requestUpdate: (() => void) | null = null;
	private runs: { [J in Judge]?: JudgmentRun[] } = {};
	private has = false;
	private bg: Judge = "trend";
	private height = 0;
	private readonly bgView: IPrimitivePaneView;
	private readonly stripView: IPrimitivePaneView;

	constructor(private readonly cssVar: (name: string) => string) {
		this.bgView = {
			zOrder: () => "bottom",
			renderer: () => ({ draw: (t) => this.drawBg(t) }),
		};
		this.stripView = {
			zOrder: () => "top",
			renderer: () => ({ draw: (t) => this.drawStrips(t) }),
		};
	}

	attached(p: SeriesAttachedParameter<Time>) {
		this.chart = p.chart as IChartApi;
		this.requestUpdate = p.requestUpdate;
	}

	detached() {
		this.chart = null;
		this.requestUpdate = null;
	}

	paneViews() {
		return this.has ? [this.bgView, this.stripView] : [];
	}

	setData(judgments: BarJudgments | null, bg: Judge) {
		this.has = judgments !== null;
		this.bg = bg;
		this.runs = judgments
			? {
					trend: judgmentRuns(judgments.trend),
					risk: judgmentRuns(judgments.risk),
					sentiment: judgmentRuns(judgments.sentiment),
				}
			: {};
		this.redraw();
	}

	redraw() {
		this.requestUpdate?.();
	}

	/** 帯の上なら、その帯の判定 */
	stripAt(y: number): Judge | null {
		if (!this.has) return null;
		const top = this.height - stripArea(true) + STRIP_PAD;
		if (y < top) return null;
		const k = Math.floor((y - top) / (STRIP_H + STRIP_GAP));
		return stripJudges(this.bg)[k] ?? null;
	}

	/** 区間の左右の端（px）。足の間隔の半分ずつ広げて、隣の区間と隙間なく並べる */
	private xRange(r: JudgmentRun): [number, number] | null {
		const ts = this.chart?.timeScale();
		if (!ts) return null;
		// 小数の論理位置は正しく変換されないので、整数位置と足の間隔から端を求める
		const a = ts.logicalToCoordinate(r.from as never);
		const b = ts.logicalToCoordinate(r.to as never);
		const half = ts.options().barSpacing / 2;
		return a === null || b === null ? null : [a - half, b + half];
	}

	private fillRuns(
		scope: BitmapScope,
		judge: Judge,
		color: "bg" | "solid",
		y: number,
		h: number,
	) {
		const {
			context: c,
			horizontalPixelRatio: hr,
			verticalPixelRatio: vr,
		} = scope;
		for (const r of this.runs[judge] ?? []) {
			const x = this.xRange(r);
			if (!x) continue;
			c.fillStyle = this.cssVar(valueStyle(judge, r.value as never)[color]);
			c.fillRect(
				Math.round(x[0] * hr),
				Math.round(y * vr),
				Math.max(1, Math.round((x[1] - x[0]) * hr)),
				Math.round(h * vr),
			);
		}
	}

	private drawBg(t: Target) {
		inBitmap(t, (scope) => {
			this.height = scope.mediaSize.height;
			this.fillRuns(scope, this.bg, "bg", 0, this.height - stripArea(true));
		});
	}

	private drawStrips(t: Target) {
		inBitmap(t, (scope) => {
			const {
				context: c,
				horizontalPixelRatio: hr,
				verticalPixelRatio: vr,
			} = scope;
			const { width: W, height: H } = scope.mediaSize;
			this.height = H;
			const area = stripArea(true);
			c.fillStyle = this.cssVar("--color-surface");
			c.fillRect(
				0,
				Math.round((H - area) * vr),
				Math.round(W * hr),
				Math.round(area * vr),
			);
			stripJudges(this.bg).forEach((judge, k) => {
				const y = H - area + STRIP_PAD + k * (STRIP_H + STRIP_GAP);
				this.fillRuns(scope, judge, "solid", y, STRIP_H);
				const label = JUDGE_LABELS[judge];
				c.font = `600 ${Math.round(10 * vr)}px sans-serif`;
				const tw = c.measureText(label).width;
				// ラベルは右端に置く（左下は描画ライブラリのロゴと重なるため）
				const lx = Math.round(W * hr) - tw - Math.round(12 * hr);
				c.globalAlpha = 0.85;
				c.fillStyle = this.cssVar("--color-surface");
				c.fillRect(
					lx - Math.round(4 * hr),
					Math.round((y + 1) * vr),
					tw + Math.round(8 * hr),
					Math.round((STRIP_H - 2) * vr),
				);
				c.globalAlpha = 1;
				c.fillStyle = this.cssVar("--color-text");
				c.textBaseline = "middle";
				c.fillText(label, lx, Math.round((y + STRIP_H / 2) * vr));
			});
		});
	}
}
