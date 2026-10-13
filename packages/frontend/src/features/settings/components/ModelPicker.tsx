import type { CompatibleModelsResult } from "@trading-studio/backend";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useApi } from "../../../shared/lib/api";
import type { ModelGroup, ModelOption } from "../../../shared/lib/model-picker";
import { filterModels, modelLabel } from "../../../shared/lib/model-picker";
import { errorMessage, readJson } from "../../../shared/lib/useAsync";

type Compatible =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "done"; result: CompatibleModelsResult }
	| { kind: "error"; message: string };

/**
 * 採点・アドバイスのモデルの選択欄。Gemini 直結の固定一覧と、OpenAI 互換の接続先から取った一覧を並べ、入力で絞り込む。
 * OpenAI 互換の一覧は数十件以上になりうるので、開いたときに取りに行く
 */
export function ModelPicker({
	id,
	fixed,
	value,
	disabled,
	onChange,
}: {
	id: string;
	/** Gemini 直結のモデル */
	fixed: ModelOption[];
	value: string | null;
	disabled?: boolean;
	onChange: (id: string) => void;
}) {
	const api = useApi();
	const listId = useId();
	const wrapRef = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const [compatible, setCompatible] = useState<Compatible>({ kind: "idle" });

	const groups: ModelGroup[] = useMemo(
		() => [
			{ name: "Gemini", models: fixed },
			{
				name: "OpenAI 互換",
				models:
					compatible.kind === "done" && compatible.result.ok
						? compatible.result.models
						: [],
			},
		],
		[fixed, compatible],
	);
	const shown = useMemo(() => filterModels(groups, query), [groups, query]);
	const flat = shown.flatMap((g) => g.models);

	const loadCompatible = () => {
		setCompatible({ kind: "loading" });
		api.api.ai.compatible.models
			.$get()
			.then((r) => readJson<CompatibleModelsResult>(r))
			.then((result) => setCompatible({ kind: "done", result }))
			.catch((e) => setCompatible({ kind: "error", message: errorMessage(e) }));
	};

	const openList = () => {
		if (open || disabled) return;
		setOpen(true);
		setQuery("");
		setActive(0);
		// 開くたびに取り直す。接続先でモデルを足したらすぐ選べるようにするため
		if (compatible.kind !== "loading") loadCompatible();
	};
	const close = () => {
		setOpen(false);
		setQuery("");
	};
	const pick = (m: ModelOption) => {
		onChange(m.id);
		close();
	};

	useEffect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			if (wrapRef.current?.contains(e.target as Node)) return;
			setOpen(false);
			setQuery("");
		};
		document.addEventListener("pointerdown", onDown);
		return () => document.removeEventListener("pointerdown", onDown);
	}, [open]);

	const compatibleNote =
		compatible.kind === "loading" || compatible.kind === "idle"
			? "一覧を取得中"
			: compatible.kind === "error"
				? `一覧を取得できなかった: ${compatible.message}`
				: !compatible.result.ok
					? compatible.result.message
					: compatible.result.models.length === 0
						? "接続先にモデルが無い"
						: null;
	const optionId = (i: number) => `${listId}-${i}`;
	let index = -1;

	return (
		<div ref={wrapRef} className="relative min-w-0 flex-1">
			<input
				id={id}
				type="text"
				role="combobox"
				aria-expanded={open}
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={
					open && flat.length > 0 ? optionId(active) : undefined
				}
				autoComplete="off"
				spellCheck={false}
				disabled={disabled}
				value={open ? query : value === null ? "" : modelLabel(groups, value)}
				placeholder={open ? "入力して絞り込む" : undefined}
				onFocus={openList}
				onClick={openList}
				onChange={(e) => {
					setQuery(e.target.value);
					setActive(0);
				}}
				onKeyDown={(e) => {
					if (!open) {
						if (e.key === "ArrowDown") openList();
						return;
					}
					if (e.key === "ArrowDown") {
						e.preventDefault();
						setActive((a) => Math.max(0, Math.min(a + 1, flat.length - 1)));
					} else if (e.key === "ArrowUp") {
						e.preventDefault();
						setActive((a) => Math.max(a - 1, 0));
					} else if (e.key === "Enter") {
						e.preventDefault();
						const m = flat[active];
						if (m) pick(m);
					} else if (e.key === "Escape") {
						close();
					} else if (e.key === "Tab") {
						close();
					}
				}}
				className="h-11 w-full rounded-lg border border-line bg-surface px-3 text-[15px]"
			/>
			{open && (
				<div
					id={listId}
					role="listbox"
					aria-label="モデル"
					className="absolute top-full right-0 left-0 z-20 mt-1 max-h-[60vh] overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-lg"
				>
					{shown.map((g) => (
						<div key={g.name}>
							<p className="px-3 pt-2 pb-1 text-xs font-bold text-text-2">
								{g.name}
							</p>
							{g.name === "OpenAI 互換" && compatibleNote && (
								<p
									data-testid="compatible-models-note"
									className="px-3 pb-1 text-xs text-text-2"
								>
									{compatibleNote}
								</p>
							)}
							{g.models.length === 0 &&
								query.trim() !== "" &&
								!(g.name === "OpenAI 互換" && compatibleNote) && (
									<p className="px-3 pb-1 text-xs text-text-2">一致なし</p>
								)}
							{g.models.map((m) => {
								index++;
								const i = index;
								return (
									<div
										key={m.id}
										id={optionId(i)}
										role="option"
										aria-selected={m.id === value}
										tabIndex={-1}
										onPointerDown={(e) => e.preventDefault()}
										onClick={() => pick(m)}
										onMouseEnter={() => setActive(i)}
										onKeyDown={(e) => {
											if (e.key === "Enter") pick(m);
										}}
										className={`num cursor-pointer px-3 py-2 text-sm break-all ${i === active ? "bg-surface-2" : ""} ${m.id === value ? "font-bold" : ""}`}
									>
										{m.label}
									</div>
								);
							})}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
