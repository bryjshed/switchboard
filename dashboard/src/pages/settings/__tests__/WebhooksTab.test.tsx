import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Webhook, WebhookDelivery } from '@/types/api'

const listWebhooks = vi.fn()
const createWebhook = vi.fn()
const updateWebhook = vi.fn()
const deleteWebhook = vi.fn()
const listWebhookDeliveries = vi.fn()

vi.mock('@/lib/webhooksApi', () => ({
  listWebhooks: (...args: unknown[]) => listWebhooks(...args),
  createWebhook: (...args: unknown[]) => createWebhook(...args),
  updateWebhook: (...args: unknown[]) => updateWebhook(...args),
  deleteWebhook: (...args: unknown[]) => deleteWebhook(...args),
  listWebhookDeliveries: (...args: unknown[]) => listWebhookDeliveries(...args),
}))

const { WebhooksTab } = await import('@/pages/settings/WebhooksTab')

function makeWebhook(patch: Partial<Webhook> = {}): Webhook {
  return {
    id: 'wh-1',
    orgId: 'org-1',
    url: 'https://example.test/hook',
    eventTypes: [],
    enabled: true,
    createdAt: '2026-08-25T10:00:00Z',
    ...patch,
  } as Webhook
}

function makeDelivery(patch: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id: 'dl-1',
    webhookId: 'wh-1',
    eventId: 'ev-1',
    eventType: 'flag.updated',
    status: 'DELIVERED',
    attempts: 1,
    createdAt: '2026-08-25T10:01:00Z',
    ...patch,
  } as WebhookDelivery
}

beforeEach(() => {
  vi.clearAllMocks()
  listWebhooks.mockResolvedValue([])
  listWebhookDeliveries.mockResolvedValue([])
})

describe('WebhooksTab', () => {
  it('says so plainly when there are none', async () => {
    render(<WebhooksTab orgId="org-1" />)
    expect(await screen.findByTestId('webhooks-empty')).toBeInTheDocument()
  })

  it('renders an empty event-type list as "All events", not as blank', async () => {
    // The API reads an empty filter as EVERY type. Rendering it as nothing would tell the
    // operator the opposite of what the webhook actually does.
    listWebhooks.mockResolvedValue([makeWebhook({ eventTypes: [] })])
    render(<WebhooksTab orgId="org-1" />)
    expect(await screen.findByText('All events')).toBeInTheDocument()
  })

  it('lists the selected event types when the filter is set', async () => {
    listWebhooks.mockResolvedValue([
      makeWebhook({ eventTypes: ['flag.kill_switch', 'flag.rollback'] }),
    ])
    render(<WebhooksTab orgId="org-1" />)
    expect(await screen.findByText('flag.kill_switch, flag.rollback')).toBeInTheDocument()
  })

  it('shows the signing secret once, after creating', async () => {
    const user = userEvent.setup()
    createWebhook.mockResolvedValue({ ...makeWebhook(), secret: 'whsec_abc123' })
    render(<WebhooksTab orgId="org-1" />)
    await screen.findByTestId('webhooks-empty')

    await user.click(screen.getByTestId('create-webhook'))
    await user.type(screen.getByTestId('webhook-url'), 'https://example.test/hook')
    await user.click(screen.getByTestId('confirm-create-webhook'))

    expect(await screen.findByTestId('revealed-secret')).toHaveTextContent('whsec_abc123')
  })

  it('sends no eventTypes when none are ticked, so the API applies its all-events default', async () => {
    const user = userEvent.setup()
    createWebhook.mockResolvedValue({ ...makeWebhook(), secret: 'whsec_x' })
    render(<WebhooksTab orgId="org-1" />)
    await screen.findByTestId('webhooks-empty')

    await user.click(screen.getByTestId('create-webhook'))
    await user.type(screen.getByTestId('webhook-url'), 'https://example.test/hook')
    await user.click(screen.getByTestId('confirm-create-webhook'))

    await waitFor(() => expect(createWebhook).toHaveBeenCalled())
    expect(createWebhook.mock.calls[0][1]).toMatchObject({ eventTypes: undefined })
  })

  it('sends exactly the ticked event types', async () => {
    const user = userEvent.setup()
    createWebhook.mockResolvedValue({ ...makeWebhook(), secret: 'whsec_x' })
    render(<WebhooksTab orgId="org-1" />)
    await screen.findByTestId('webhooks-empty')

    await user.click(screen.getByTestId('create-webhook'))
    await user.type(screen.getByTestId('webhook-url'), 'https://example.test/hook')
    await user.click(screen.getByTestId('event-flag.kill_switch'))
    await user.click(screen.getByTestId('confirm-create-webhook'))

    await waitFor(() => expect(createWebhook).toHaveBeenCalled())
    expect(createWebhook.mock.calls[0][1]).toMatchObject({ eventTypes: ['flag.kill_switch'] })
  })

  it('refuses to submit without a URL', async () => {
    const user = userEvent.setup()
    render(<WebhooksTab orgId="org-1" />)
    await screen.findByTestId('webhooks-empty')
    await user.click(screen.getByTestId('create-webhook'))
    expect(screen.getByTestId('confirm-create-webhook')).toBeDisabled()
  })

  it('toggles enabled without asking for the rest of the webhook', async () => {
    // PATCH semantics: sending only `enabled` must not require the caller to resend filters,
    // or a toggle would silently overwrite them.
    const user = userEvent.setup()
    listWebhooks.mockResolvedValue([makeWebhook({ enabled: true })])
    updateWebhook.mockResolvedValue(makeWebhook({ enabled: false }))
    render(<WebhooksTab orgId="org-1" />)
    await screen.findByTestId('webhook-wh-1')

    await user.click(screen.getByTestId('toggle-wh-1'))
    await waitFor(() => expect(updateWebhook).toHaveBeenCalledWith('wh-1', { enabled: false }))
  })

  it('loads deliveries only when a row is expanded', async () => {
    const user = userEvent.setup()
    listWebhooks.mockResolvedValue([makeWebhook()])
    listWebhookDeliveries.mockResolvedValue([makeDelivery()])
    render(<WebhooksTab orgId="org-1" />)
    await screen.findByTestId('webhook-wh-1')

    // Not fetched on render: a list of ten webhooks would otherwise fire ten requests for
    // detail nobody has asked to see.
    expect(listWebhookDeliveries).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('expand-wh-1'))
    expect(await screen.findByTestId('deliveries')).toBeInTheDocument()
    expect(listWebhookDeliveries).toHaveBeenCalledWith('wh-1')
  })

  it('shows a failed delivery with its status code and error', async () => {
    const user = userEvent.setup()
    listWebhooks.mockResolvedValue([makeWebhook()])
    listWebhookDeliveries.mockResolvedValue([
      makeDelivery({ status: 'FAILED', attempts: 6, responseStatus: 500, error: 'HTTP 500' }),
    ])
    render(<WebhooksTab orgId="org-1" />)
    await screen.findByTestId('webhook-wh-1')
    await user.click(screen.getByTestId('expand-wh-1'))

    expect(await screen.findByText('failed')).toBeInTheDocument()
    expect(screen.getByText(/6 attempts · HTTP 500/)).toBeInTheDocument()
  })

  it('confirms before deleting', async () => {
    const user = userEvent.setup()
    listWebhooks.mockResolvedValue([makeWebhook()])
    deleteWebhook.mockResolvedValue(undefined)
    render(<WebhooksTab orgId="org-1" />)
    await screen.findByTestId('webhook-wh-1')

    await user.click(screen.getByTestId('delete-wh-1'))
    expect(deleteWebhook).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('confirm-delete-webhook'))
    await waitFor(() => expect(deleteWebhook).toHaveBeenCalledWith('wh-1'))
  })

  it('surfaces a load failure instead of rendering an empty list', async () => {
    // An empty list and a broken API look identical otherwise, and one of them means
    // "your webhooks are not firing".
    listWebhooks.mockRejectedValue(new Error('boom'))
    render(<WebhooksTab orgId="org-1" />)
    expect(await screen.findByText(/Could not load webhooks|boom/)).toBeInTheDocument()
    expect(screen.queryByTestId('webhooks-empty')).not.toBeInTheDocument()
  })
})
