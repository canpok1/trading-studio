// ライト / ダークの切り替え。初期値は OS の設定に従い、手動で選んだらブラウザに保存する（サーバーには持たない）

import { useCallback, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "theme";

function readPreference(): ThemePreference {
	try {
		const v = localStorage.getItem(STORAGE_KEY);
		return v === "light" || v === "dark" ? v : "system";
	} catch {
		return "system";
	}
}

function writePreference(p: ThemePreference): void {
	try {
		if (p === "system") localStorage.removeItem(STORAGE_KEY);
		else localStorage.setItem(STORAGE_KEY, p);
	} catch {
		// 保存できない環境（プライベートモードなど）では、この画面を開いている間だけ効く
	}
}

const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme(p: ThemePreference): void {
	const dark = p === "dark" || (p === "system" && darkQuery().matches);
	document.documentElement.classList.toggle("dark", dark);
	document.documentElement.style.colorScheme = dark ? "dark" : "light";
	// チャートなど CSS のクラスが効かない部品が色を読み直すため
	window.dispatchEvent(new Event("themechange"));
}

/** 画面を描く前に1回呼ぶ（一瞬ライトで表示されるのを防ぐ）。OS の設定が変わったら、OS に合わせる設定のときだけ追従する */
export function initTheme(): void {
	applyTheme(readPreference());
	darkQuery().addEventListener("change", () => {
		if (readPreference() === "system") applyTheme("system");
	});
}

export function useTheme() {
	const [preference, setPreference] = useState<ThemePreference>(readPreference);

	const set = useCallback((p: ThemePreference) => {
		writePreference(p);
		applyTheme(p);
		setPreference(p);
	}, []);

	return { preference, setPreference: set };
}
