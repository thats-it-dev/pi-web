// The show_image tool: puts an image file from the session's working directory
// into the conversation, and (by default) in front of the model too.

import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ContentBlock } from "../shared/src/protocol.ts";
import { sniffImageType } from "../shared/src/images.ts";

export const MAX_IMAGE_FILE_BYTES = 2_000_000;

export interface ShowImageParams {
	path: string;
	caption?: string;
	see?: boolean;
}

export interface ShowImageDetails {
	path: string;
	caption?: string;
	mimeType: string;
	bytes: number;
	image?: { type: "image"; data: string; mimeType: string };
}

export async function showImage(params: ShowImageParams, cwd: string): Promise<{ content: ContentBlock[]; details: ShowImageDetails }> {
	const path = resolve(cwd, params.path);
	let bytes: Buffer;
	try {
		bytes = await readFile(path);
	} catch (e) {
		throw new Error(`Cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (bytes.length > MAX_IMAGE_FILE_BYTES) {
		throw new Error(`${path} is ${(bytes.length / 1_000_000).toFixed(1)} MB; the limit is 2 MB. Downscale it (for example with ImageMagick) and try again.`);
	}
	const mimeType = sniffImageType(bytes);
	if (!mimeType) throw new Error(`${path} is not a PNG, JPEG, GIF or WebP image.`);
	const data = bytes.toString("base64");
	const details: ShowImageDetails = { path, mimeType, bytes: bytes.length };
	if (params.caption !== undefined) details.caption = params.caption;
	const content: ContentBlock[] = [{ type: "text", text: `Displayed in the conversation: ${basename(path)}` }];
	if (params.see === false) details.image = { type: "image", data, mimeType };
	else content.push({ type: "image", mimeType, data });
	return { content, details };
}
