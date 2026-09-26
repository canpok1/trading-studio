import { Page } from "../components/Page";
import type { ThemePreference } from "../theme";
import { useTheme } from "../theme";

const OPTIONS: [ThemePreference, string][] = [
	["system", "OS に合わせる"],
	["light", "ライト"],
	["dark", "ダーク"],
];

export function SettingsPage() {
	const { preference, setPreference } = useTheme();
	return (
		<Page title="表示設定" back="/other">
			<section className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface px-4 py-3.5">
				<h2 className="text-[15px] font-bold">画面の色</h2>
				<fieldset className="grid auto-cols-fr grid-flow-col gap-0.5 rounded-[10px] bg-surface-2 p-[3px]">
					<legend className="sr-only">画面の色</legend>
					{OPTIONS.map(([value, label]) => (
						<label
							key={value}
							className="flex h-9 cursor-pointer items-center justify-center rounded-lg text-[13px] text-text-2 has-checked:bg-surface has-checked:font-bold has-checked:text-text has-checked:shadow-sm has-focus-visible:outline-2 has-focus-visible:outline-accent"
						>
							<input
								type="radio"
								name="theme"
								value={value}
								checked={preference === value}
								onChange={() => setPreference(value)}
								className="sr-only"
							/>
							{label}
						</label>
					))}
				</fieldset>
				<p className="text-xs text-text-2">
					選んだ設定はこのブラウザに保存する
				</p>
			</section>
		</Page>
	);
}
