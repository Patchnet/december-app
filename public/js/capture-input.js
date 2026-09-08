// Shared intake contract: reject the whole submission rather than trim it.
export const CAPTURE_TEXT_LIMIT = 8000
export const CAPTURE_LINE_LIMIT = 25
export function validateCaptureText(value) {
  const text = String(value ?? '').trim()
  if (!text) throw Object.assign(new Error('Write something first.'), {statusCode:400})
  if (text.length > CAPTURE_TEXT_LIMIT) throw Object.assign(new Error('A note can contain up to 8,000 characters. Split this into smaller notes; nothing was accepted.'), {statusCode:413})
  return text
}
export function parseCaptureInput(value) {
  const text = String(value ?? '').trim()
  const lines = text.includes('\n') ? text.split('\n').map(line => line.replace(/^[-*•]\s*/, '').trim()).filter(Boolean) : [text]
  if (lines.length > CAPTURE_LINE_LIMIT) throw Object.assign(new Error('File up to 25 lines at a time. Split this paste; nothing was accepted.'), {statusCode:413})
  if (!lines.length) throw Object.assign(new Error('Write something first.'), {statusCode:400})
  return lines.map(validateCaptureText)
}
