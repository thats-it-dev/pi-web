import { ImageLoader } from "./image-loader.ts";

// An ImageLoader that fetches under the session's current id: a fork, clone or
// /new changes the id mid-view, and the old id no longer has the new images.
export function sessionImageLoader(
	api: { image(sessionId: string, ref: string): Promise<Blob> },
	store: { id: string },
	createUrl?: (b: Blob) => string,
	revokeUrl?: (u: string) => void,
): ImageLoader {
	return new ImageLoader((ref) => api.image(store.id, ref), createUrl, revokeUrl);
}
