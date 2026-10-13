import { afterAll, beforeAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent } from "@testing-library/react";

/**
 * 画面のテストファイルの先頭で呼ぶ。DOM はそのファイルの間だけ用意し、backend のテストへ持ち込まない（Response などが happy-dom の実装に置き換わるため）。
 * import した時点で用意する形にしないのは、モジュールが1度しか評価されず、2つ目以降のファイルで用意されないため
 */
export function setupDom() {
	beforeAll(() => GlobalRegistrator.register());
	// 外す前に画面を片付け、React が予約した処理を流し切る。DOM を外した後に走ると window が無いと落ちる
	afterAll(async () => {
		cleanup();
		await new Promise((r) => setTimeout(r, 50));
		await GlobalRegistrator.unregister();
	});
}

/**
 * テキスト・日付・数値の入力欄に値を入れる。fireEvent.change では React の onChange が呼ばれないため。
 * Bun では react-dom が DOM を用意する前に評価され、input イベントを使えない環境とみなして、フォーカス中の欄の値をキー操作のたびに見る方式で変化を拾う。
 * 両方の方式で拾えるよう、input イベントとキー操作の両方を送る
 */
export function changeValue(el: HTMLElement, value: string) {
	const proto = Object.getPrototypeOf(el);
	fireEvent.focusIn(el);
	Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
	fireEvent.input(el);
	fireEvent.keyUp(el);
}
