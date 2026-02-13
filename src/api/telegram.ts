const res = await fetch('http://localhost:3000/telegram/qr/start', {
  method: 'POST',
})
const { sessionId } = await res.json()
