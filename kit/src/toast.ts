export type ToastLevel = "info" | "warning" | "error";
export interface ToastDetail {
	message: string;
	level: ToastLevel;
}

export const TOAST_EVENT = "tk-toast";

export function toast(message: string, level: ToastLevel = "info"): void {
	window.dispatchEvent(new CustomEvent<ToastDetail>(TOAST_EVENT, { detail: { message, level } }));
}
