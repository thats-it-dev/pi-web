// Whether a file drag is over a view. dragenter/dragleave fire for every child
// element, so a depth counter says when the drag has really left the host.
export class DropTarget {
	over = false;
	private depth = 0;

	enter(e: DragEvent): void {
		if (!e.dataTransfer?.types.includes("Files")) return;
		this.depth++;
		this.over = true;
	}

	leave(): void {
		if (this.depth > 0) this.depth--;
		if (this.depth === 0) this.over = false;
	}

	drop(e: DragEvent): File[] {
		this.depth = 0;
		this.over = false;
		return [...(e.dataTransfer?.files ?? [])];
	}
}
