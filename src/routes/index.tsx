import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { io } from 'socket.io-client'
import { QRCode } from 'react-qrcode-logo'
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
  expires: number
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

// ── Hook ──────────────────────────────────────────────────────────────────────

function useTelegramAuth() {
  const socketRef = useRef<Socket | null>(null)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [qr, setQr] = useState<QrPayload | null>(null)
  const [status, setStatus] = useState<AuthStatus>('idle')
  const [userId, setUserId] = useState<string | null>(null)
  const [serverTwoFaError, setServerTwoFaError] = useState<string | null>(null)

  const clearCountdown = useCallback(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current)
      countdownRef.current = null
    }
  }, [])

  const requestQR = useCallback(() => {
    socketRef.current?.emit('telegram.qr.create')
    setStatus('pending')
    setQr(null)
    setServerTwoFaError(null)
  }, [])

  const startCountdown = useCallback(
    (expiresUnix: number, onExpire: () => void) => {
      clearCountdown()
      const tick = () => {
        const secs = expiresUnix - Math.floor(Date.now() / 1000)
        if (secs <= 0) {
          clearCountdown()
          onExpire()
        }
      }
      tick()
      countdownRef.current = setInterval(tick, 1000)
    },
    [clearCountdown],
  )

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
      startCountdown(data.expires, () => requestQR())
    })

    socket.on('telegram.qr.status', (data: StatusPayload) => {
      setStatus(data.status)
      if (data.userId) setUserId(data.userId)
      if (data.status === 'awaiting_2fa') {
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

  return { qr, status, userId, serverTwoFaError, requestQR }
}

// ── App ───────────────────────────────────────────────────────────────────────

function App() {
  const { qr, status, userId, serverTwoFaError, requestQR } = useTelegramAuth()
  const [password, setPassword] = useState('')

  const {
    mutate: doSubmit2FA,
    isPending,
    error: mutationError,
    reset: resetMutation,
  } = useMutation({
    mutationFn: ({ loginId, pw }: { loginId: string; pw: string }) =>
      submit2FA(loginId, pw),
    onSuccess: () => setPassword(''),
    onError: () => setPassword(''),
  })

  const twoFaError =
    serverTwoFaError ??
    (mutationError instanceof Error ? mutationError.message : null)

  const handle2FASubmit = () => {
    if (!password.trim() || !qr) return
    resetMutation()
    doSubmit2FA({ loginId: qr.loginId, pw: password })
  }

  return (
    <div className="tg-root">
      <div className="tg-card">
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
          <QRView qr={qr} status={status} onRefresh={requestQR} />
        )}
      </div>
    </div>
  )
}

// ── Sub-views ─────────────────────────────────────────────────────────────────

function QRView({
  qr,
  status,
  onRefresh,
}: {
  qr: QrPayload | null
  status: AuthStatus
  onRefresh: () => void
}) {
  return (
    <>
      <div className="tg-qr-wrap">
        {qr ? (
          <div
            className={`tg-qr-frame ${status === 'scanned' ? 'scanned' : ''}`}
          >
            <QRCode
              value={qr.url}
              size={220}
              qrStyle="squares"
              bgColor="#ffffff"
              fgColor="#000000"
              logoImage="https://upload.wikimedia.org/wikipedia/commons/8/82/Telegram_logo.svg"
              logoWidth={52}
              logoHeight={52}
              logoOpacity={1}
              removeQrCodeBehindLogo={true}
              eyeRadius={4}
            />
            {status === 'scanned' && (
              <div className="tg-qr-overlay">
                <div className="tg-qr-check">
                  <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                    <path
                      d="M6 16L13 23L26 9"
                      stroke="#ffffff"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="tg-qr-skeleton" />
        )}
      </div>

      <h2 className="tg-title">Log in to Telegram by QR Code</h2>

      <ol className="tg-steps">
        <li>
          <span className="tg-step-num">1</span>
          <span>Open Telegram on your phone</span>
        </li>
        <li>
          <span className="tg-step-num">2</span>
          <span>
            Go to{' '}
            <strong>Settings &gt; Devices &gt; Link Desktop Device</strong>
          </span>
        </li>
        <li>
          <span className="tg-step-num">3</span>
          <span>
            {status === 'scanned'
              ? 'Confirm login on your device…'
              : 'Point your phone at this screen to confirm login'}
          </span>
        </li>
      </ol>

      {status === 'expired' && (
        <button className="tg-link-btn" onClick={onRefresh}>
          Refresh QR Code
        </button>
      )}
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
    <div className="tg-2fa-wrap">
      <div className="tg-2fa-icon">
        <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
          <path
            d="M12 16V12a6 6 0 1 1 12 0v4"
            stroke="#2481cc"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <rect
            x="7"
            y="16"
            width="22"
            height="14"
            rx="3"
            fill="#2481cc"
            fillOpacity="0.15"
            stroke="#2481cc"
            strokeWidth="2"
          />
          <circle cx="18" cy="23" r="2" fill="#2481cc" />
        </svg>
      </div>

      <h2 className="tg-title">Two-Step Verification</h2>
      <p className="tg-body">
        This account has two-step verification enabled.
        <br />
        Enter your Telegram cloud password.
      </p>

      <div className="tg-field-wrap">
        <input
          ref={inputRef}
          className={`tg-field ${error ? 'tg-field--error' : ''}`}
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => onPasswordChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
          disabled={isLoading}
          autoComplete="current-password"
        />
        {error && <p className="tg-field-error">{error}</p>}
      </div>

      <button
        className="tg-btn"
        onClick={onSubmit}
        disabled={isLoading || !password.trim()}
      >
        {isLoading ? <Spinner /> : 'Next'}
      </button>
    </div>
  )
}

function SuccessView({ userId: _ }: { userId: string | null }) {
  useEffect(() => {
    window.location.href = 'https://telegram.org/'
  }, [])

  return null
}

function Spinner() {
  return <span className="tg-spinner" aria-label="Loading" />
}
