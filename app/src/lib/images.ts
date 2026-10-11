export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function checkImageFile(f: { type: string; size: number }): boolean {
	return IMAGE_TYPES.includes(f.type) && f.size <= MAX_IMAGE_BYTES;
}
