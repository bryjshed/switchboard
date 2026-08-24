import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RequirePermission } from '@/components/RequirePermission'
import { PermissionsContext, type PermissionsState } from '@/context/permissionsContext'
import type { Permission } from '@/types/api'

function state(overrides: Partial<PermissionsState> = {}): PermissionsState {
  const permissions = overrides.permissions ?? new Set<Permission>()
  return {
    permissions,
    scopeType: 'ENVIRONMENT',
    scopeId: 'env-prod',
    scopeName: 'Production',
    loading: false,
    error: null,
    has: (...wanted) => permissions !== null && wanted.every((p) => permissions.has(p)),
    hasAny: (...wanted) => permissions !== null && wanted.some((p) => permissions.has(p)),
    refresh: async () => {},
    ...overrides,
  }
}

function renderGate(value: PermissionsState, children = <button>Save changes</button>, props = {}) {
  return render(
    <PermissionsContext.Provider value={value}>
      <RequirePermission permission="FLAG_WRITE" {...props}>
        {children}
      </RequirePermission>
    </PermissionsContext.Provider>,
  )
}

describe('RequirePermission', () => {
  it('renders the control when the viewer holds the permission', () => {
    renderGate(state({ permissions: new Set<Permission>(['FLAG_WRITE']) }))
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument()
  })

  it('replaces the control with an explanation when they do not', () => {
    renderGate(state({ permissions: new Set<Permission>(['FLAG_READ']) }))
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
    expect(screen.getByTestId('permission-denied-FLAG_WRITE')).toBeInTheDocument()
  })

  // A caption saying "FLAG_WRITE required" tells a person nothing they can act on.
  it('names the capability in words and says who to ask', () => {
    renderGate(state({ permissions: new Set<Permission>() }))
    const caption = screen.getByTestId('permission-denied-FLAG_WRITE')
    expect(caption).toHaveTextContent(/edit targeting/i)
    expect(caption).toHaveTextContent(/Production environment/i)
    expect(caption).toHaveTextContent(/ask an owner or admin/i)
    expect(caption.textContent).not.toContain('FLAG_WRITE')
  })

  it('renders a custom fallback when one is given', () => {
    renderGate(state(), <button>Save changes</button>, {
      fallback: <span data-testid="custom">Read-only</span>,
    })
    expect(screen.getByTestId('custom')).toBeInTheDocument()
    expect(screen.queryByTestId('permission-denied-FLAG_WRITE')).not.toBeInTheDocument()
  })

  it('renders nothing at all in silent mode', () => {
    const { container } = renderGate(state(), <button>Save changes</button>, { silent: true })
    expect(container).toBeEmptyDOMElement()
  })

  // Flashing a write control into view and then removing it is worse than never showing it.
  it('withholds the control while permissions are still loading', () => {
    renderGate(state({ permissions: null, loading: true }))
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
    expect(screen.getByTestId('permission-denied-FLAG_WRITE')).toHaveTextContent(/checking/i)
  })

  // Failing open would offer every button to someone who holds nothing.
  it('withholds the control when the permission lookup failed', () => {
    renderGate(state({ permissions: new Set<Permission>(), error: 'network down' }))
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
  })
})
