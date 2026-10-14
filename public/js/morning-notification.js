import { morningLine } from './morning-line.js'

// A morning belongs to the local calendar. Opening after lunch must not
// deliver a missed morning, and waking the app must not repeat one.
export const isMorning = (now) => now.getHours() >= 8 && now.getHours() < 12

export function createMorningNotifier({ storage, notify, onOpen }) {
  let delivered = ''
  return (day, now = new Date()) => {
    if (!isMorning(now)) return false
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    if (delivered === date) return false
    try {
      if (storage.getItem('dec-morning-date') === date) return false
    } catch { return false } // cannot deduplicate safely without storage
    const line = morningLine(day)
    let notification
    try {
      notification = notify(line.title, { body: line.body, silent: true, tag: `dec-morning-${date}` })
    } catch { return false } // a failed delivery can be tried again
    delivered = date
    notification.onclick = () => {
      notification.close()
      onOpen()
    }
    try { storage.setItem('dec-morning-date', date) } catch { /* remembered in this window */ }
    return true
  }
}
