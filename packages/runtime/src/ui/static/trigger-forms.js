/* global Jedison */

class EditorInlineMultiple extends Jedison.EditorMultiple {
  static resolves(schema) { return Jedison.EditorMultiple.resolves(schema); }
  build() {
    const inst = this.instance;
    this.switcherInput = 'select';
    this.embedSwitcher = false;
    this.control = this.theme.getMultipleControl({
      titleHidden: true,
      id: this.getIdFromPath(inst.path),
      switcherOptionValues: inst.switcherOptionValues,
      switcherOptionsLabels: inst.switcherOptionsLabels,
      switcher: 'select',
      readOnly: inst.isReadOnly()
    });
    const header = this.control.header;
    const body = this.control.body;
    const label = document.createElement('label');
    label.textContent = inst.getKey();
    label.classList.add('jedi-title');
    this.control.container.insertBefore(label, header);
    header.style.display = 'flex';
    header.style.gap = '8px';
    header.querySelector('.jedi-switcher').style.flex = '0 0 auto';
    body.style.flex = '1 1 0';
    body.style.minWidth = '0';
    header.appendChild(body);
  }
  addEventListeners() {
    if (this.control.switcher?.input) {
      this.control.switcher.input.addEventListener('change', () => {
        const idx = Number(this.control.switcher.input.value);
        this.instance.switchInstance(idx, undefined, 'user');
      });
    }
  }
  // biome-ignore lint/style/useNamingConvention: Jedison API requires this method name
  refreshUI() {
    this.refreshDisabledState();
    this.control.childrenSlot.innerHTML = '';
    const child = this.instance.activeInstance;
    if (child?.ui) {
      const cc = child.ui.control;
      if (cc.label) {
        cc.label.style.display = 'none';
      }
      cc.container.style.margin = '0';
      this.control.childrenSlot.appendChild(cc.container);
    }
  }
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick/ontoggle attributes
function initForm(details) {
  if (!details.open || details._jedison) {
    return;
  }
  const script = details.querySelector('script[type="application/json"]');
  const schema = JSON.parse(script.textContent);
  const container = details.querySelector('.form-container');
  details._jedison = new Jedison.Create({
    container,
    theme: new Jedison.Theme(),
    customEditors: [EditorInlineMultiple],
    schema,
    showErrors: 'never'
  });
  const props = schema.properties || {};
  const required = (schema.required || []).filter((key) => !(props[key]?.anyOf));
  for (const key of required) {
    const el = container.querySelector(`[data-path="#/${key}"]`);
    if (el) {
      el.classList.add('jedi-required');
    }
  }
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick attributes
function submitEvent(btn, eventType) {
  const details = btn.closest('.event-details');
  const jedison = details._jedison;
  if (!jedison) {
    return;
  }
  const target = details.querySelector('.banner-target');
  fetch(`/trigger/${encodeURIComponent(eventType)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(jedison.getValue())
  })
  .then((r) => r.text())
  .then((html) => { target.innerHTML = html; });
}
