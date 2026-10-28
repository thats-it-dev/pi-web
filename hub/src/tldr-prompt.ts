// System-prompt rule appended to every headless pi spawn. The hub reads the trailing
// `TL;DR [title]: outcome` line off the final reply for push notifications.
export const TLDR_PROMPT =
	"When you finish a turn with a final reply to the user, end that reply with one last line of the form `TL;DR [<title>]: <outcome>`. `<title>` is 2–4 words, at most 24 characters, naming what the turn was about. `<outcome>` is one sentence of at most 100 characters stating what was done or found. No questions, no suggestions, no next steps. Write it only on your final reply of the turn, never on intermediate messages.";
