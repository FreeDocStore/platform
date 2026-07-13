import { useEffect, useState } from 'react'
import type { PwaInstallPrompt } from '../model'

export function usePwa() {
  const [installPrompt, setInstallPrompt] = useState<PwaInstallPrompt | null>(null)
  const [pwaReady, setPwaReady] = useState(false)
  const [updateAvailable, setUpdateAvailable] = useState(false)

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as PwaInstallPrompt)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onPrompt)
  }, [])

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    let cancelled = false
    let removeUpdateFound: (() => void) | undefined
    navigator.serviceWorker.ready.then(() => {
      if (!cancelled) setPwaReady(true)
    }).catch(() => {})
    navigator.serviceWorker.getRegistration().then((registration) => {
      if (!registration || cancelled) return
      if (registration.waiting) setUpdateAvailable(true)
      const onUpdateFound = () => {
        const worker = registration.installing
        if (!worker) return
        worker.addEventListener('statechange', () => {
          if (!cancelled && worker.state === 'installed' && navigator.serviceWorker.controller) setUpdateAvailable(true)
        })
      }
      registration.addEventListener('updatefound', onUpdateFound)
      removeUpdateFound = () => registration.removeEventListener('updatefound', onUpdateFound)
    }).catch(() => {})
    return () => {
      cancelled = true
      removeUpdateFound?.()
    }
  }, [])

  async function installApp() {
    if (!installPrompt) return
    await installPrompt.prompt()
    setInstallPrompt(null)
  }

  async function activateUpdate() {
    const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null
    registration?.waiting?.postMessage({ type: 'SKIP_WAITING' })
    window.location.reload()
  }

  return { installPrompt, pwaReady, updateAvailable, installApp, activateUpdate }
}
