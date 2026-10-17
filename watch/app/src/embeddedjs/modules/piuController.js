// Screen stack: goTo pushes, goBack/goHome pop; each screen is rebuilt from its
// view (and the shared model) when shown, and swapped in without a transition.
class Controller extends Behavior {
	constructor() {
		super();
		this.history = [];
		this.view = null;
	}
	display(container, view, backwards) {
		const old = this.view;
		const content = new view.Template(view, { left:0, right:0, top:0, bottom:0 });
		if (old) {
			this.onScreenUndisplaying(container, old);
			if (!backwards) this.history.push(old);
			container.replace(container.first, content);
			old.purge();
			container.purge();
		}
		else
			container.add(content);
		this.view = view;
		// After Piu has sent onDisplaying (the screens build there).
		container.defer("onScreenDisplayed", view);
	}
	goBack() {
		if (this.history.length)
			this.container.defer("display", this.history.pop(), true);
	}
	goHome() {
		if (this.history.length) {
			const view = this.history[0];
			this.history.length = 0;
			this.container.defer("display", view, true);
		}
	}
	goTo(id) {
		const View = importNow(id).default;
		const view = new View();
		view.id = id;
		this.container.defer("display", view, false);
	}
	onCreate(container) {
		this.container = container;
		watch.addEventListener("minutechange", () => this.onTimeChanged(container));
	}
	onScreenDisplayed(container, view) {
		container.first.distribute("onDisplayed");
	}
	onScreenUndisplaying(container, view) {
		container.first.distribute("onUndisplaying");
	}
	onTimeChanged(container) {
		container.distribute("onClockChanged");
	}
}

export default Controller;
