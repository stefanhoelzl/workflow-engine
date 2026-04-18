// Auto-submit the tenant selector form when the user picks a different
// tenant. Inline event handlers would violate the CSP (§6), so we wire the
// change listener here via a data-attribute hook on the form.
(() => {
	function attach(form) {
		const select = form.querySelector("select[name=tenant]");
		if (!select) {
			return;
		}
		select.addEventListener("change", () => {
			form.submit();
		});
		const button = form.querySelector(".topbar-tenant-go");
		if (button) {
			button.hidden = true;
		}
	}
	document.querySelectorAll("form[data-tenant-selector]").forEach(attach);
})();
