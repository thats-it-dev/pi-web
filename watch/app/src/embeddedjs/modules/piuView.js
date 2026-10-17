// Screens swap instantly (no slide transitions; the spec asks for none), which
// also keeps the mod small: in the emulator the archive is copied into the app
// heap, so every KB of bytecode is a KB of RAM.
class ViewBehavior extends Behavior {
	onCreate(container, view) {
		this.view = view;
	}
	onDisplayed(container) {
		container.focus();
	}
	onPressBack(container) {
		if (controller.history.length) {
			controller.goBack();
			return true;
		}
	}
	onUndisplaying(container) {
		controller.container.focus();
	}
}

class View {
	static get Behavior() { return ViewBehavior }
	constructor(data) {
		this.data = data;
	}
	// Drops the view's references to Piu contents so a screen in history holds no tree.
	purge() {
		for (const key in this)
			if (this[key] instanceof Content) delete this[key];
	}
}

Object.freeze(View);

export default View;
