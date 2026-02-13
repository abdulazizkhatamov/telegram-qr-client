import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { io } from 'socket.io-client'
import { QRCodeSVG } from 'qrcode.react'
import type { Socket } from 'socket.io-client'

export const Route = createFileRoute('/')({
  component: App,
})

type QrData = {
  loginId: string
  url: string
  expires: number
}

function App() {
  const [socket, setSocket] = useState<Socket | null>(null)
  const [qr, setQr] = useState<QrData | null>(null)
  const [expiresIn, setExpiresIn] = useState<number>(0)

  useEffect(() => {
    const s = io('http://localhost:3000') // your NestJS server
    setSocket(s)

    s.on('connect', () => {
      console.log('Connected:', s.id)
      s.emit('telegram.qr.create')
    })

    s.on('telegram.qr', (data: QrData) => {
      setQr(data)

      const now = Math.floor(Date.now() / 1000)
      setExpiresIn(data.expires - now)
    })

    return () => {
      s.disconnect()
    }
  }, [])

  // Countdown timer
  useEffect(() => {
    if (!expiresIn) return

    const interval = setInterval(() => {
      setExpiresIn((prev) => {
        if (prev <= 1) {
          socket?.emit('telegram.qr.create') // auto refresh QR
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(interval)
  }, [expiresIn, socket])

  return (
    <div style={{ textAlign: 'center' }}>
      <h2>Login via Telegram QR</h2>

      {qr ? (
        <div style={{ width: '100%' }}>
          <QRCodeSVG style={{ margin: '0 auto' }} value={qr.url} size={256} />
          <p>Expires in: {expiresIn}s</p>
        </div>
      ) : (
        <p>Loading QR...</p>
      )}
    </div>
  )
}
