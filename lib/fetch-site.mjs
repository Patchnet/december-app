// Who is allowed to reach a December running on this machine.
//
// Browsers stamp Sec-Fetch-Site on every request they make. same-origin is
// December's own page, none is a person typing the address; anything else is
// another site reaching in. Clients that are not browsers — the MCP adapter,
// the desktop shell, curl — send no such header and are yours.
const OWN_FETCH_SITES = new Set(['same-origin', 'none'])

// The one cross-site request a person makes on purpose is following a link to
// December: a top-level GET for a document. The browser navigates away to show
// it, so no other page can read the answer, and everything that changes
// anything here is a POST. A script reaching in for data asks with dest empty
// and is still refused.
function topLevelVisit(method, headers) {
  return method === 'GET'
    && headers['sec-fetch-mode'] === 'navigate'
    && headers['sec-fetch-dest'] === 'document'
}

export function foreignFetchSite(headers, method = 'GET') {
  const site = headers['sec-fetch-site']
  if (!site) return false
  if (OWN_FETCH_SITES.has(String(site))) return false
  return !topLevelVisit(method, headers)
}
