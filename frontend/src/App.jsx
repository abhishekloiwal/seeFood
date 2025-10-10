import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:5000'
const MAX_FILES = 10
const FILE_SIZE_LIMIT_MB = 12

const formatBytes = (bytes) => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

const resolveUrl = (pathOrUrl) => {
  if (!pathOrUrl) return ''
  try {
    return new URL(pathOrUrl, API_BASE_URL).toString()
  } catch (error) {
    return pathOrUrl
  }
}

function App() {
  const fileInputRef = useRef(null)
  const [selectedFiles, setSelectedFiles] = useState([])
  const [previews, setPreviews] = useState([])
  const [isProcessing, setIsProcessing] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [items, setItems] = useState([])
  const [pages, setPages] = useState([])
  const [sessionId, setSessionId] = useState('')

  useEffect(() => {
    return () => {
      previews.forEach((preview) => URL.revokeObjectURL(preview.url))
    }
  }, [previews])

  const totalFileSizeMb = useMemo(() => {
    const totalBytes = selectedFiles.reduce((acc, file) => acc + file.size, 0)
    return (totalBytes / (1024 * 1024)).toFixed(2)
  }, [selectedFiles])

  const handleFileChange = (event) => {
    const files = Array.from(event.target.files ?? [])
    files.forEach((file) => {
      if (file.size / (1024 * 1024) > FILE_SIZE_LIMIT_MB) {
        setErrorMessage(`\"${file.name}\" exceeds the ${FILE_SIZE_LIMIT_MB} MB limit.`)
      }
    })

    const filtered = files
      .filter((file) => file.size / (1024 * 1024) <= FILE_SIZE_LIMIT_MB)
      .slice(0, MAX_FILES)

    const nextPreviews = filtered.map((file) => ({
      name: file.name,
      size: file.size,
      url: URL.createObjectURL(file),
      type: file.type,
    }))

    setSelectedFiles(filtered)
    setPreviews(nextPreviews)
  }

  const handleReset = () => {
    setSelectedFiles([])
    setPreviews([])
    setErrorMessage('')
    setItems([])
    setPages([])
    setSessionId('')
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!selectedFiles.length) {
      setErrorMessage('Please choose up to 10 menu images to continue.')
      return
    }

    setIsProcessing(true)
    setErrorMessage('')
    setItems([])
    setPages([])
    setSessionId('')

    const formData = new FormData()
    selectedFiles.forEach((file) => {
      formData.append('menu_images', file)
    })

    try {
      const response = await fetch(`${API_BASE_URL}/api/process`, {
        method: 'POST',
        body: formData,
      })

      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        throw new Error(data?.error ?? 'Failed to process menu.')
      }

      const resolvedPages = (data.pages ?? []).map((page) => ({
        ...page,
        url: resolveUrl(page.url),
      }))

      const resolvedItems = (data.items ?? []).map((item) => ({
        ...item,
        image_url: resolveUrl(item.image_url),
      }))

      setSessionId(data.sessionId ?? '')
      setPages(resolvedPages)
      setItems(resolvedItems)
    } catch (error) {
      setErrorMessage(error.message || 'Something went wrong. Please try again.')
    } finally {
      setIsProcessing(false)
    }
  }

  return (
    <div className="app">
      <header className="hero">
        <div className="hero__content">
          <h1>SeeFood Menu Digitizer</h1>
          <p>
            Upload multi-page menus (up to 10 images) and automatically extract item names, pricing, descriptions, and AI-generated photography.
          </p>
        </div>
      </header>

      <main className="content">
        <section className="panel">
          <form className="upload-form" onSubmit={handleSubmit}>
            <div className="form-header">
              <div>
                <h2>Upload menu images</h2>
                <p>Select JPG, PNG, WebP, or HEIC files. Each file must be under {FILE_SIZE_LIMIT_MB} MB.</p>
              </div>
              <button type="button" className="link-button" onClick={handleReset}>
                Start over
              </button>
            </div>

            <label htmlFor="menu-files" className="dropzone">
              <span className="dropzone__icon" aria-hidden="true">📄</span>
              <div>
                <strong>Click to browse</strong> or drag & drop your menu images here.
              </div>
              <span className="dropzone__hint">You can add up to {MAX_FILES} files · Total selected size: {totalFileSizeMb} MB</span>
              <input
                id="menu-files"
                type="file"
                accept="image/*"
                multiple
                onChange={handleFileChange}
                ref={fileInputRef}
              />
            </label>

            {previews.length > 0 && (
              <div className="preview-grid">
                {previews.map((preview, index) => (
                  <figure key={`${preview.name}-${index}`} className="preview-card">
                    <img src={preview.url} alt={`${preview.name} preview`} />
                    <figcaption>
                      <strong>{preview.name}</strong>
                      <span>{formatBytes(preview.size)}</span>
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}

            {errorMessage && <div className="alert alert--error">{errorMessage}</div>}

            <button type="submit" className="primary" disabled={isProcessing}>
              {isProcessing ? 'Processing…' : 'Generate menu cards'}
            </button>
          </form>
        </section>

        {pages.length > 0 && (
          <section className="panel">
            <div className="section-header">
              <h2>Uploaded pages</h2>
              {sessionId && <span className="session-tag">Session {sessionId}</span>}
            </div>
            <div className="preview-grid">
              {pages.map((page) => (
                <figure key={`${page.page}-${page.url}`} className="preview-card">
                  <img src={page.url} alt={`Menu page ${page.page}`} />
                  <figcaption>
                    <strong>Page {page.page}</strong>
                    <span>{page.name}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
        )}

        {items.length > 0 && (
          <section className="panel">
            <div className="section-header">
              <h2>Generated menu items</h2>
              <span>{items.length} items</span>
            </div>
            <div className="card-grid">
              {items.map((item, index) => (
                <article key={`${item.name}-${index}`} className="card">
                  <img src={item.image_url} alt={item.name} loading="lazy" />
                  <div className="card__body">
                    <div className="card__heading">
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

      <footer className="footer">
        Built with Gemini · fal.ai · Flask · React
      </footer>
    </div>
  )
}

export default App
