// A presentation fold for long lists beside media. Every row stays in the
// DOM, with native disclosure semantics; ordinary lists are not folded.
export const MEDIA_LIST_LIMIT = 6
export function mediaListMarkup(rows, id, expanded = false) {
  if (rows.length <= MEDIA_LIST_LIMIT) return rows.join('')
  const safeId = String(id).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
  const count = rows.length - MEDIA_LIST_LIMIT
  return `${rows.slice(0, MEDIA_LIST_LIMIT).join('')}
    <details class="list-preview" data-list-preview="${safeId}"${expanded ? ' open' : ''}>
      <summary><span class="list-expand">Show ${count} more</span><span class="list-collapse">Show fewer</span><span class="list-chevron" aria-hidden="true">⌄</span></summary>
      ${rows.slice(MEDIA_LIST_LIMIT).join('')}
    </details>`
}
