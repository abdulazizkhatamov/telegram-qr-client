import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { io } from 'socket.io-client'
import { QRCodeSVG } from 'qrcode.react'
import type { Socket } from 'socket.io-client'

export const Route = createFileRoute('/')({
  component: App,
})

// ── Types ─────────────────────────────────────────────────────────────────────

type AuthStatus =
  | 'idle'
  | 'pending'
  | 'scanned'
  | 'awaiting_2fa'
  | 'success'
  | 'expired'

interface QrPayload {
  loginId: string
  url: string
  expires: number // unix timestamp
}

interface StatusPayload {
  status: AuthStatus
  userId: string | null
  twoFaError: string | null
}

// ── API ───────────────────────────────────────────────────────────────────────

async function submit2FA(loginId: string, password: string): Promise<void> {
  const res = await fetch('http://localhost:3000/telegram/2fa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginId, password }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.message ?? 'Incorrect password. Please try again.')
  }
}

// ── Hook: manages the entire socket + auth state machine ─────────────────────

function useTelegramAuth() {
  const socketRef = useRef<Socket | null>(null)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [qr, setQr] = useState<QrPayload | null>(null)
  const [status, setStatus] = useState<AuthStatus>('idle')
  const [expiresIn, setExpiresIn] = useState(0)
  const [userId, setUserId] = useState<string | null>(null)
  // twoFaError surfaced from the server via the status watcher (wrong pw etc.)
  const [serverTwoFaError, setServerTwoFaError] = useState<string | null>(null)

  const clearCountdown = useCallback(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current)
      countdownRef.current = null
    }
  }, [])

  const startCountdown = useCallback(
    (expiresUnix: number, onExpire: () => void) => {
      clearCountdown()
      const tick = () => {
        const secs = expiresUnix - Math.floor(Date.now() / 1000)
        if (secs <= 0) {
          clearCountdown()
          onExpire()
        } else {
          setExpiresIn(secs)
        }
      }
      tick()
      countdownRef.current = setInterval(tick, 1000)
    },
    [clearCountdown],
  )

  const requestQR = useCallback(() => {
    socketRef.current?.emit('telegram.qr.create')
    setStatus('pending')
    setQr(null)
    setServerTwoFaError(null)
  }, [])

  useEffect(() => {
    const socket = io('http://localhost:3000')
    socketRef.current = socket

    socket.on('connect', () => {
      socket.emit('telegram.qr.create')
      setStatus('pending')
    })

    socket.on('telegram.qr', (data: QrPayload) => {
      setQr(data)
      setStatus('pending')
      startCountdown(data.expires, () => {
        // QR expired client-side — request a new one immediately
        requestQR()
      })
    })

    socket.on('telegram.qr.status', (data: StatusPayload) => {
      setStatus(data.status)

      if (data.userId) setUserId(data.userId)

      if (data.status === 'awaiting_2fa') {
        // Stop the QR countdown — user is now on the 2FA screen
        clearCountdown()
        setServerTwoFaError(data.twoFaError)
      }

      if (data.status === 'success' || data.status === 'expired') {
        clearCountdown()
      }
    })

    socket.on('disconnect', () => setStatus('idle'))

    return () => {
      clearCountdown()
      socket.disconnect()
    }
  }, [startCountdown, clearCountdown, requestQR])

  return { qr, status, expiresIn, userId, serverTwoFaError, requestQR }
}

// ── Component ─────────────────────────────────────────────────────────────────

function App() {
  const { qr, status, expiresIn, userId, serverTwoFaError, requestQR } =
    useTelegramAuth()

  const [password, setPassword] = useState('')

  const {
    mutate: doSubmit2FA,
    isPending,
    error: mutationError,
    reset: resetMutation,
  } = useMutation({
    mutationFn: ({ loginId, pw }: { loginId: string; pw: string }) =>
      submit2FA(loginId, pw),
    onSuccess: () => {
      // Status will flip to 'success' via the socket watcher — nothing to do here
      setPassword('')
    },
    onError: () => {
      setPassword('')
    },
  })

  // The error to show: server-pushed error (wrong pw detected server-side)
  // OR the mutation's own fetch/parse error
  const twoFaError =
    serverTwoFaError ??
    (mutationError instanceof Error ? mutationError.message : null)

  const handle2FASubmit = () => {
    if (!password.trim() || !qr) return
    resetMutation()
    doSubmit2FA({ loginId: qr.loginId, pw: password })
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      <style>{css}</style>
      <div className="root">
        <div className="card">
          {status === 'success' && <SuccessView userId={userId} />}

          {status === 'awaiting_2fa' && (
            <TwoFAView
              password={password}
              onPasswordChange={(v) => {
                setPassword(v)
                resetMutation()
              }}
              onSubmit={handle2FASubmit}
              isLoading={isPending}
              error={twoFaError}
            />
          )}

          {(status === 'idle' ||
            status === 'pending' ||
            status === 'scanned' ||
            status === 'expired') && (
            <QRView
              qr={qr}
              status={status}
              expiresIn={expiresIn}
              onRefresh={requestQR}
            />
          )}
        </div>
      </div>
    </>
  )
}

// ── Sub-views ─────────────────────────────────────────────────────────────────

function QRView({
  qr,
  status,
  expiresIn,
  onRefresh,
}: {
  qr: QrPayload | null
  status: AuthStatus
  expiresIn: number
  onRefresh: () => void
}) {
  return (
    <>
      <div className="eyebrow">TELEGRAM</div>
      <h1 className="title">Sign in</h1>
      <p className="body">
        {status === 'scanned'
          ? 'QR scanned — confirming on your device…'
          : 'Open Telegram on your phone and scan the code.'}
      </p>

      <div className="qr-area">
        {qr ? (
          <div className={`qr-frame ${status === 'scanned' ? 'scanned' : ''}`}>
            <QRCodeSVG
              value={qr.url}
              size={180}
              bgColor="transparent"
              fgColor="#e8eaf0"
              level="M"
            />
            {status === 'scanned' && (
              <div className="qr-check">
                <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
                  <path
                    d="M8 20L16 28L32 12"
                    stroke="#4ade80"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            )}
          </div>
        ) : (
          <div className="qr-skeleton" />
        )}
      </div>

      {status === 'expired' ? (
        <button className="btn" onClick={onRefresh}>
          Refresh QR
        </button>
      ) : qr && status === 'pending' ? (
        <div className="timer">
          <div
            className="timer-bar"
            style={
              { '--pct': `${(expiresIn / 30) * 100}%` } as React.CSSProperties
            }
          />
          <span className="timer-label">Expires in {expiresIn}s</span>
        </div>
      ) : null}
    </>
  )
}

function TwoFAView({
  password,
  onPasswordChange,
  onSubmit,
  isLoading,
  error,
}: {
  password: string
  onPasswordChange: (v: string) => void
  onSubmit: () => void
  isLoading: boolean
  error: string | null
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <>
      <div className="eyebrow">2FA</div>
      <h1 className="title">Cloud password</h1>
      <p className="body">
        This account has two-step verification enabled.
        <br />
        Enter your Telegram cloud password to continue.
      </p>

      <div className="field-wrap">
        <input
          ref={inputRef}
          className={`field ${error ? 'field--error' : ''}`}
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => onPasswordChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
          disabled={isLoading}
          autoComplete="current-password"
        />
        {error && <p className="field-error">{error}</p>}
      </div>

      <button
        className="btn"
        onClick={onSubmit}
        disabled={isLoading || !password.trim()}
      >
        {isLoading ? <Spinner /> : 'Confirm'}
      </button>
    </>
  )
}

function SuccessView({ userId }: { userId: string | null }) {
  return (
    <>
      <div className="success-icon">
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
          <path
            d="M5 14L11 20L23 8"
            stroke="#0d0f12"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h1 className="title">Authenticated</h1>
      <p className="body">
        {userId ? (
          <>
            Signed in as user <span className="mono">{userId}</span>
          </>
        ) : (
          'You are now signed in to Telegram.'
        )}
      </p>
    </>
  )
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />
}

// ── Styles ────────────────────────────────────────────────────────────────────

const css = `
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: #0d0f12;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'Syne', sans-serif;
    color: #e8eaf0;
  }

  .root {
    min-height: 100vh;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background:
      radial-gradient(ellipse 60% 50% at 20% 80%, rgba(56,189,248,0.06) 0%, transparent 70%),
      radial-gradient(ellipse 50% 40% at 80% 20%, rgba(99,102,241,0.05) 0%, transparent 70%),
      #0d0f12;
  }

  .card {
    width: 100%;
    max-width: 380px;
    background: #13161c;
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 20px;
    padding: 44px 40px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0;
    box-shadow: 0 0 0 1px rgba(0,0,0,0.4), 0 32px 64px rgba(0,0,0,0.5);
  }

  .eyebrow {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.2em;
    color: #38bdf8;
    margin-bottom: 14px;
  }

  .title {
    font-size: 28px;
    font-weight: 800;
    letter-spacing: -0.5px;
    color: #f0f2f8;
    margin-bottom: 12px;
    text-align: center;
  }

  .body {
    font-size: 14px;
    line-height: 1.65;
    color: #7c8097;
    text-align: center;
    margin-bottom: 32px;
  }

  /* ── QR ── */

  .qr-area {
    margin-bottom: 28px;
  }

  .qr-frame {
    position: relative;
    padding: 16px;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 14px;
    background: #0d0f12;
    transition: opacity 0.3s;
  }

  .qr-frame.scanned {
    opacity: 0.4;
  }

  .qr-check {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .qr-skeleton {
    width: 212px;
    height: 212px;
    border-radius: 12px;
    background: linear-gradient(90deg, #1a1d24 25%, #21242d 50%, #1a1d24 75%);
    background-size: 200% 100%;
    animation: shimmer 1.4s infinite;
  }

  @keyframes shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  /* ── Timer ── */

  .timer {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
  }

  .timer-bar {
    width: 100%;
    height: 2px;
    background: #1e222c;
    border-radius: 2px;
    position: relative;
    overflow: hidden;
  }

  .timer-bar::after {
    content: '';
    position: absolute;
    inset-block: 0;
    left: 0;
    width: var(--pct, 100%);
    background: #38bdf8;
    border-radius: 2px;
    transition: width 0.9s linear;
  }

  .timer-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #4a5070;
    letter-spacing: 0.05em;
  }

  /* ── 2FA ── */

  .field-wrap {
    width: 100%;
    margin-bottom: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .field {
    width: 100%;
    padding: 13px 16px;
    background: #0d0f12;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 10px;
    color: #e8eaf0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    outline: none;
    transition: border-color 0.15s;
    letter-spacing: 0.1em;
  }

  .field::placeholder {
    color: #3a3f52;
    letter-spacing: normal;
    font-family: 'Syne', sans-serif;
  }

  .field:focus {
    border-color: #38bdf8;
  }

  .field--error {
    border-color: #f87171 !important;
  }

  .field-error {
    font-size: 12px;
    color: #f87171;
    padding-left: 2px;
  }

  /* ── Button ── */

  .btn {
    width: 100%;
    padding: 13px;
    border-radius: 10px;
    border: none;
    background: #38bdf8;
    color: #0d0f12;
    font-family: 'Syne', sans-serif;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
    transition: background 0.15s, transform 0.1s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    letter-spacing: 0.01em;
  }

  .btn:hover:not(:disabled) {
    background: #7dd3fc;
  }

  .btn:active:not(:disabled) {
    transform: scale(0.98);
  }

  .btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  /* ── Success ── */

  .success-icon {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: #4ade80;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 20px;
  }

  .mono {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    color: #38bdf8;
  }

  /* ── Spinner ── */

  .spinner {
    display: inline-block;
    width: 16px;
    height: 16px;
    border: 2px solid rgba(13,15,18,0.3);
    border-top-color: #0d0f12;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
`
