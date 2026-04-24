// Auto-submit the owner selector form when the user picks a different
// owner. Inline event handlers would violate the CSP (§6), so we wire the
// change listener here via a data-attribute hook on the form.
(() => {
	function attach(form) {
		const select = form.querySelector("select[name=owner]");
		if (!select) {
			return;
		}
		select.addEventListener("change", () => {
			form.submit();
		});
		const button = form.querySelector(".topbar-owner-go");
		if (button) {
			button.hidden = true;
		}
	}
	document.querySelectorAll("form[data-owner-selector]").forEach(attach);
})();
