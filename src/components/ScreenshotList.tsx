import { formatTimestamp } from '../lib/formatTime'

export type ScreenshotEntry = {
  id: string
  imageDataUrl: string
  seconds: number
  note: string
}

type ScreenshotListProps = {
  items: ScreenshotEntry[]
  onNoteChange: (id: string, note: string) => void
  onRemove: (id: string) => void
}

export function ScreenshotList({ items, onNoteChange, onRemove }: ScreenshotListProps) {
  if (items.length === 0) {
    return (
      <div className="list-empty">
        <p className="list-empty-title">No captures yet</p>
        <p className="list-empty-hint">
          Start a capture session, then grab frames while you study. Each shot stores the exact
          timestamp from the player.
        </p>
      </div>
    )
  }

  return (
    <ul className="shot-list">
      {items.map((item) => (
        <li key={item.id} className="shot-card">
          <div className="shot-thumb-wrap">
            <img
              src={item.imageDataUrl}
              alt={`Capture at ${formatTimestamp(item.seconds)}`}
              className="shot-thumb"
            />
          </div>
          <div className="shot-body">
            <div className="shot-meta">
              <span className="shot-time">{formatTimestamp(item.seconds)}</span>
              <button
                type="button"
                className="btn-text danger"
                onClick={() => onRemove(item.id)}
                aria-label={`Remove capture at ${formatTimestamp(item.seconds)}`}
              >
                Remove
              </button>
            </div>
            <label className="sr-only" htmlFor={`note-${item.id}`}>
              Note for {formatTimestamp(item.seconds)}
            </label>
            <textarea
              id={`note-${item.id}`}
              className="shot-note"
              placeholder="Optional note…"
              value={item.note}
              onChange={(e) => onNoteChange(item.id, e.target.value)}
              rows={3}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}
