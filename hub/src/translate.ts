import type { AppCommand } from "../../shared/src/protocol.ts";

export type RpcCommand = { type: string; [key: string]: unknown };
export type RpcTranslatable = Exclude<AppCommand, { type: "attach" } | { type: "export" }>;

export function toRpc(cmd: RpcTranslatable): RpcCommand {
	switch (cmd.type) {
		case "prompt":
			return {
				type: "prompt",
				message: cmd.text,
				...(cmd.images?.length ? { images: cmd.images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })) } : {}),
				...(cmd.mode === "send" ? {} : { streamingBehavior: cmd.mode }),
			};
		case "abort":
			return { type: "abort" };
		case "set_model":
			return { type: "set_model", provider: cmd.provider, modelId: cmd.modelId };
		case "set_thinking":
			return { type: "set_thinking_level", level: cmd.level };
		case "compact":
			return cmd.instructions ? { type: "compact", customInstructions: cmd.instructions } : { type: "compact" };
		case "rename":
			return { type: "set_session_name", name: cmd.name };
		case "get_fork_points":
			return { type: "get_fork_messages" };
		case "fork":
			return { type: "fork", entryId: cmd.entryId };
		case "clone":
			return { type: "clone" };
		case "new_session":
			return { type: "new_session" };
		case "bash":
			return { type: "bash", command: cmd.command, excludeFromContext: cmd.excludeFromContext };
		case "dialog_response": {
			const { type: _type, ...rest } = cmd;
			return { type: "extension_ui_response", ...rest };
		}
		case "clear_queue":
			return { type: "clear_queue" };
	}
}
