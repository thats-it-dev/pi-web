export type ToastLevel = "info" | "warning" | "error";
export interface ToastDetail {
	message: string;
	level: ToastLevel;
}

export function toast(message: string, level: ToastLevel = "info"): void {
	window.dispatchEvent(new CustomEvent<ToastDetail>("pi-toast", { detail: { message, level } }));
}
