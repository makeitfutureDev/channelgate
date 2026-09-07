// Compact, local-directory multi-select. Search is view state; only adding/removing calls onChange.
export function mountUserPicker(container, { users = {}, selected = [], onChange = () => {} } = {}) {
  const doc = container.ownerDocument;
  const chosen = new Set(selected);
  const options = [...new Set([...Object.keys(users).filter((id) => /^[UW][A-Z0-9]+$/.test(id)), ...selected])]
    .map((id) => ({ id, name: users[id]?.name || id }))
    .sort((a, b) => a.name.localeCompare(b.name));
  let matches = [];
  let active = -1;
  const el = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  container.replaceChildren();
  const chips = el("div", "user-picker-chips");
  chips.setAttribute("aria-label", "Selected testing users");
  const input = el("input", "user-picker-search checks-filter");
  input.type = "search";
  input.placeholder = "Search users by name or Slack ID…";
  input.autocomplete = "off";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-label", "Search Slack testing users");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  const list = el("div", "user-picker-results");
  list.id = `${container.id}-results`;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Available testing users");
  input.setAttribute("aria-controls", list.id);
  list.hidden = true;
  const status = el("p", "user-picker-status");
  status.setAttribute("role", "status");
  container.append(chips, input, list, status);

  const close = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
    status.textContent = chosen.size ? `${chosen.size} selected` : "No testing users selected.";
  };
  const highlight = () => {
    [...list.children].forEach((row, index) => {
      row.classList.toggle("active", index === active);
      row.setAttribute("aria-selected", String(index === active));
    });
    if (active >= 0) {
      input.setAttribute("aria-activedescendant", list.children[active].id);
      list.children[active].scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  };
  const renderChips = () => {
    chips.replaceChildren();
    for (const id of chosen) {
      const name = options.find((user) => user.id === id)?.name || id;
      const chip = el("span", "user-picker-chip");
      chip.title = id;
      const remove = el("button", "", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${name}`);
      remove.addEventListener("click", () => {
        chosen.delete(id);
        renderChips();
        input.focus();
        renderResults();
        onChange();
      });
      chip.append(el("span", "", name), remove);
      chips.append(chip);
    }
    chips.hidden = !chosen.size;
  };
  const add = (user) => {
    if (!user || chosen.has(user.id)) return;
    chosen.add(user.id);
    input.value = "";
    renderChips();
    input.focus();
    renderResults();
    onChange();
  };
  const renderResults = () => {
    const query = input.value.trim().toLocaleLowerCase();
    const filtered = options.filter((user) => !chosen.has(user.id) &&
      `${user.name} ${user.id}`.toLocaleLowerCase().includes(query));
    matches = filtered.slice(0, 30);
    active = -1;
    list.replaceChildren();
    matches.forEach((user, index) => {
      const row = el("div", "user-picker-option");
      row.id = `${list.id}-${index}`;
      row.setAttribute("role", "option");
      row.append(el("strong", "", user.name), el("small", "", user.id));
      // Keep keyboard focus on the combobox while a pointer chooses an option.
      row.addEventListener("pointerdown", (event) => event.preventDefault());
      row.addEventListener("click", () => add(user));
      list.append(row);
    });
    list.hidden = !matches.length;
    input.setAttribute("aria-expanded", String(!list.hidden));
    status.textContent = !filtered.length
      ? (query ? "No matching users." : "No more users to add.")
      : `${chosen.size} selected · ${filtered.length > matches.length ? `Showing ${matches.length} of ${filtered.length} — type to narrow results` : `${filtered.length} available`}`;
    highlight();
  };
  input.addEventListener("focus", renderResults);
  input.addEventListener("input", renderResults);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (list.hidden) renderResults();
      if (matches.length) {
        active = event.key === "ArrowDown" ? (active + 1) % matches.length : (active <= 0 ? matches.length - 1 : active - 1);
        highlight();
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!list.hidden) add(matches[active >= 0 ? active : 0]);
    }
  });
  container.onfocusout = (event) => { if (!container.contains(event.relatedTarget)) close(); };
  renderChips();
  close();
  return { getValues: () => [...chosen] };
}
