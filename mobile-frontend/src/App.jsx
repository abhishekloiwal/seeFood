import { useMemo, useRef, useState } from 'react'
import './App.css'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:5000'
const MAX_FILES = 10
const MAX_FILE_MB = 12

const formatBytes = (bytes) => {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const idx = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, idx)).toFixed(1)} ${units[idx]}`
}

const resolveStatic = (pathOrUrl) => {
  if (!pathOrUrl) return ''
  try {
    return new URL(pathOrUrl, API_BASE_URL).toString()
  } catch (error) {
    return pathOrUrl
  }
}

function App() {
  const inputRef = useRef(null)
  const [files, setFiles] = useState([])
  const [previews, setPreviews] = useState([])
  const [pages, setPages] = useState([])
  const [items, setItems] = useState([])
  const [sessionId, setSessionId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const totalSize = useMemo(
    () => files.reduce((acc, file) => acc + file.size, 0),
    [files],
  )

  const handleFileSelection = (incoming) => {
    const selected = Array.from(incoming ?? [])
    const filtered = selected
      .filter((file) => file.size / (1024 * 1024) <= MAX_FILE_MB)
      .slice(0, MAX_FILES)

    const nextPreviews = filtered.map((file) => ({
      url: URL.createObjectURL(file),
      name: file.name,
      size: file.size,
      type: file.type,
    }))

    setFiles(filtered)
    setPreviews(nextPreviews)
    setError(
      selected.length > filtered.length
        ? `We kept the first ${MAX_FILES} files under ${MAX_FILE_MB} MB.`
        : '',
    )
  }

  const onInputChange = (event) => {
    handleFileSelection(event.target.files)
  }

  const onDrop = (event) => {
    event.preventDefault()
    handleFileSelection(event.dataTransfer.files)
  }

  const onDragOver = (event) => {
    event.preventDefault()
  }

  const handleReset = () => {
    setFiles([])
    setPreviews([])
    setPages([])
    setItems([])
    setSessionId('')
    setError('')
    if (inputRef.current) {
      inputRef.current.value = ''
    }
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!files.length) {
      setError('Add at least one menu photo to continue.')
      return
    }

    const data = new FormData()
    files.forEach((file) => data.append('menu_images', file))

    try {
      setLoading(true)
      setError('')
      setPages([])
      setItems([])
      setSessionId('')

      const response = await fetch(`${API_BASE_URL}/api/process`, {
        method: 'POST',
        body: data,
      })
      const payload = await response.json().catch(() => ({}))

      if (!response.ok) {
        throw new Error(payload?.error ?? 'Menu processing failed. Try again.')
      }

      setSessionId(payload.sessionId ?? '')
      setPages((payload.pages ?? []).map((page) => ({
        ...page,
        url: resolveStatic(page.url),
      })))
      setItems((payload.items ?? []).map((item) => ({
        ...item,
        image_url: resolveStatic(item.image_url),
      })))
    } catch (processingError) {
      setError(processingError.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="app">
      <header className="app-bar">
        <div className="app-bar__details">
          <h1>SeeFood Mobile</h1>
          <p>Digitise restaurant menus on the go and keep your team aligned.</p>
        </div>
        {sessionId && <span className="session-pill">Session {sessionId}</span>}
      </header>

      <main className="screen">
        <form className="card upload-card" onSubmit={handleSubmit}>
          <div className="card__title">
            <h2>Menu photos</h2>
            <button type="button" className="ghost" onClick={handleReset} disabled={loading}>
              Clear
            </button>
          </div>
          <p className="card__subtitle">
            Select JPG, PNG, WebP, or HEIC. Max {MAX_FILES} files · {MAX_FILE_MB} MB each.
          </p>

          <div
            className={`dropzone ${loading ? 'dropzone--disabled' : ''}`}
            onDrop={onDrop}
            onDragOver={onDragOver}
            role="button"
            tabIndex={0}
          >
            <div className="dropzone__icon" aria-hidden="true">
              📷
            </div>
            <div className="dropzone__text">
              <strong>Tap to browse</strong>
              <span>or drag menu pages here</span>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={onInputChange}
              disabled={loading}
            />
          </div>

          {previews.length > 0 && (
            <div className="preview-strip">
              {previews.map((preview) => (
                <figure className="preview" key={preview.url}>
                  <img src={preview.url} alt={preview.name} />
                  <figcaption>
                    <span className="preview__name">{preview.name}</span>
                    <span className="preview__size">{formatBytes(preview.size)}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}

          {error && <div className="notice notice--error">{error}</div>}

          <button type="submit" className="cta" disabled={loading}>
            {loading ? 'Processing…' : 'Generate menu cards'}
          </button>

          <div className="meta-row">
            <span>{files.length} files</span>
            <span>{formatBytes(totalSize)}</span>
          </div>
        </form>

        {pages.length > 0 && (
          <section className="card section">
            <h2 className="section__title">Captured pages</h2>
            <div className="page-grid">
              {pages.map((page) => (
                <figure className="page" key={`${page.page}-${page.url}`}>
                  <img src={page.url} alt={`Menu page ${page.page}`} loading="lazy" />
                  <figcaption>Page {page.page}</figcaption>
                </figure>
              ))}
            </div>
          </section>
        )}

        {items.length > 0 && (
          <section className="card section">
            <div className="section__title section__title--row">
              <h2>Menu items</h2>
              <span className="section__meta">{items.length} items</span>
            </div>
            <div className="item-grid">
              {items.map((item, index) => (
                <article className="dish" key={`${item.name}-${index}`}>
                  <img src={item.image_url} alt={item.name} loading="lazy" />
                  <div className="dish__body">
                    <div className="dish__heading">
                      <h3>{item.name}</h3>
                      <span className="price">{item.price}</span>
                    </div>
                    <p>{item.description}</p>
                    <span className="badge">Page {item.page}</span>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

export default App
