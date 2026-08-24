import '@testing-library/jest-dom'
import { vi } from 'vitest'

// Radix UI Select requires pointer capture APIs
Element.prototype.hasPointerCapture = () => false
Element.prototype.setPointerCapture = () => {}
Element.prototype.releasePointerCapture = () => {}

// Radix UI Select uses scrollIntoView
Element.prototype.scrollIntoView = () => {}

// Radix UI requires ResizeObserver
window.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// Radix UI requires window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// Radix UI Popper requires DOMRect
if (!window.DOMRect) {
  window.DOMRect = {
    fromRect: (rect?: DOMRectInit) => ({
      x: rect?.x ?? 0, y: rect?.y ?? 0,
      width: rect?.width ?? 0, height: rect?.height ?? 0,
      top: rect?.y ?? 0, left: rect?.x ?? 0,
      bottom: (rect?.y ?? 0) + (rect?.height ?? 0),
      right: (rect?.x ?? 0) + (rect?.width ?? 0),
      toJSON: () => ({}),
    }),
  } as unknown as typeof DOMRect
}
