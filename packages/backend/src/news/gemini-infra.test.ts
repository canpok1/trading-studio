import { expect, test } from "bun:test";
import { geminiModel, NO_API_KEY } from "./gemini-infra";

test("Gemini のモデルは保存されたキーを問い合わせのたびに読む", async () => {
	let key: string | null = null;
	const model = geminiModel(() => key);
	expect(model.unavailable("m")).toBe(NO_API_KEY);
	await expect(model.generate("m", "p", {})).rejects.toThrow(NO_API_KEY);
	key = "k";
	expect(model.unavailable("m")).toBeNull();
});
