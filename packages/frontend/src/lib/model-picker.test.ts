import { describe, expect, test } from "bun:test";
import { filterModels, modelLabel } from "./model-picker";

const groups = [
	{
		name: "Gemini",
		models: [{ id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" }],
	},
	{
		name: "OpenAI 互換",
		models: [
			{ id: "openai:anthropic/claude-x", label: "anthropic/claude-x" },
			{ id: "openai:openai/gpt-x-mini", label: "openai/gpt-x-mini" },
		],
	},
];

describe("モデルの絞り込み", () => {
	test("空白で区切った語をすべて含むものだけ残し、大文字・小文字を区別しない", () => {
		expect(
			filterModels(groups, "GPT mini").map((g) => g.models.map((m) => m.id)),
		).toEqual([[], ["openai:openai/gpt-x-mini"]]);
		expect(filterModels(groups, "flash").map((g) => g.models.length)).toEqual([
			1, 0,
		]);
	});

	test("空なら全部", () => {
		expect(filterModels(groups, "  ")).toEqual(groups);
	});
});

describe("選択中のモデルの表示名", () => {
	test("OpenAI 互換には接続先を添える。一覧に無くても ID から出す", () => {
		expect(modelLabel(groups, "gemini-3.5-flash-lite")).toBe(
			"Gemini 3.5 Flash-Lite",
		);
		expect(modelLabel(groups, "openai:anthropic/claude-x")).toBe(
			"anthropic/claude-x（OpenAI 互換）",
		);
		expect(modelLabel([], "openai:gone")).toBe("gone（OpenAI 互換）");
	});
});
