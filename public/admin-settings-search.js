// Generated from ui/admin/admin-settings-search.ts by npm run build:admin.
// Search only display metadata supplied by the navigator. Scores keep a field name above
// an incidental mention in setup instructions, while terms may span the category and field.
export function normalizeText(value) {
    return String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "")
        .replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
        .replace(/['’]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
export function searchTerms(query) {
    return [...new Set(normalizeText(query).split(" ").filter(Boolean))];
}
export function rankSettings(entries, query) {
    const terms = searchTerms(query);
    if (!terms.length)
        return [];
    const phrase = terms.join(" ");
    const hits = [];
    for (const entry of entries) {
        const title = normalizeText(entry.title);
        const keywords = normalizeText(entry.keywords);
        const help = normalizeText(entry.text);
        const path = normalizeText(entry.path);
        let score = title === phrase ? 100 : title.includes(phrase) ? 35 : 0;
        let localHit = false;
        let matches = true;
        for (const term of terms) {
            if (title.includes(term)) {
                score += 16;
                localHit = true;
            }
            else if (keywords.includes(term)) {
                score += 9;
                localHit = true;
            }
            else if (help.includes(term)) {
                score += 3;
                localHit = true;
            }
            else if (path.includes(term))
                score++;
            else {
                matches = false;
                break;
            }
        }
        if (matches && (localHit || entry.isCard))
            hits.push({ entry, score });
    }
    return hits.sort((a, b) => b.score - a.score).map(({ entry }) => entry);
}
