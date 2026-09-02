// Pure, DOM-free matching rules behind the Settings page search box.
//
// The settings page is ONE long scrolling page: every section and every card stays in the DOM and
// the search only decides what is *visible*. app.js builds the index from the DOM once (title +
// labels + descriptions + option text per card) and re-asks this module on every keystroke, so the
// matching rules can be regression-tested without a browser.

// Fold the typographic characters the admin markup actually uses (curly quotes, en/em dashes,
// non-breaking spaces) onto their ASCII forms so typing "daemon's" or "org-default" from a normal
// keyboard still matches text written with ’ and —.
export function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Whitespace-separated terms, AND-ed. Two terms that differ only by case or punctuation style
// collapse into one so "Slack  slack" doesn't cost two passes.
export function searchTerms(query) {
  const normalized = normalizeText(query);
  if (!normalized) return [];
  return [...new Set(normalized.split(" ").filter(Boolean))];
}

// One card's searchable haystack. The section's own title and description are folded in, so
// "connection" surfaces every card under Connection even when the word appears nowhere in the card.
export function cardHaystack(card = {}) {
  return normalizeText([card.sectionTitle, card.sectionDesc, card.title, card.text].filter(Boolean).join(" "));
}

export function cardMatches(card, terms) {
  if (!terms.length) return true;
  const haystack = card.haystack || cardHaystack(card);
  return terms.every((term) => haystack.includes(term));
}

// The one call the UI makes per keystroke. `index` is an array of
// { id, section, sectionTitle, sectionDesc, title, text } — one entry per .setcard (plus any
// non-card block that should survive filtering, e.g. the Slack status banner, which carries its
// section's text so it stays with its section).
//
// Returns which card ids and which sections stay visible. An empty query is reported as
// `active: false` with everything visible, which is what restores the untouched page.
export function filterSettings(index = [], query = "") {
  const terms = searchTerms(query);
  const cards = new Map();
  const sections = new Map();
  let matched = 0;

  for (const entry of index) {
    const hit = cardMatches(entry, terms);
    cards.set(entry.id, hit);
    if (!sections.has(entry.section)) sections.set(entry.section, 0);
    if (hit) {
      matched += 1;
      sections.set(entry.section, sections.get(entry.section) + 1);
    }
  }

  return {
    query: String(query ?? ""),
    terms,
    active: terms.length > 0,
    cards,
    sections,
    matched,
    total: index.length,
    // Only a non-empty query can produce "nothing to show" — an empty index means the page hasn't
    // been indexed yet, and blanking it then would hide settings that are perfectly fine.
    empty: terms.length > 0 && index.length > 0 && matched === 0,
  };
}

// Scroll-spy: given each section's offset inside the scroller and the current scroll position,
// pick the section the reader is actually looking at. The section whose top has passed the
// (bar-adjusted) reading line wins; before the first one has, the first section wins; scrolled to
// the very bottom the last VISIBLE section wins, so a short trailing section can still light up.
export function activeSectionFor(sections = [], scrollTop = 0, viewportHeight = 0, scrollHeight = 0) {
  const visible = sections.filter((section) => section && section.visible !== false);
  if (!visible.length) return null;
  const atBottom = scrollHeight > 0 && scrollTop + viewportHeight >= scrollHeight - 2;
  if (atBottom) return visible[visible.length - 1].id;
  let active = visible[0].id;
  for (const section of visible) {
    if (section.top <= scrollTop) active = section.id;
    else break;
  }
  return active;
}
