export async function renderTerminalPairingQr(pairingUrl: string): Promise<string | null> {
  // Why dynamic: qrcode is only reachable from mobile pairing, so launch should
  // not parse it for the majority who never pair a device. Inside the try so a
  // module-resolution failure degrades to qr: null instead of failing the mint.
  try {
    const QRCode = await import('qrcode')
    try {
      return await QRCode.toString(pairingUrl, { type: 'terminal', small: true })
    } catch {
      return await QRCode.toString(pairingUrl, { type: 'utf8' })
    }
  } catch {
    return null
  }
}
