import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/apiClient'
import type {
  Webhook,
  WebhookCreateRequest,
  WebhookCreated,
  WebhookDelivery,
  WebhookUpdateRequest,
} from '@/types/api'

/**
 * Signed outbound webhooks, scoped to an org.
 *
 * Note the asymmetry with the other API modules: create returns the signing SECRET and the
 * list never does. That is not an oversight in the server — HMAC needs the key itself rather
 * than a digest, so it is stored, but it leaves the server exactly once. The UI has to show it
 * at creation time or the caller can never sign-check a delivery.
 */

export function listWebhooks(orgId: string): Promise<Webhook[]> {
  return apiGet<Webhook[]>(`/api/orgs/${encodeURIComponent(orgId)}/webhooks`)
}

export function createWebhook(orgId: string, body: WebhookCreateRequest): Promise<WebhookCreated> {
  return apiPost<WebhookCreated>(`/api/orgs/${encodeURIComponent(orgId)}/webhooks`, body)
}

export function updateWebhook(webhookId: string, body: WebhookUpdateRequest): Promise<Webhook> {
  return apiPatch<Webhook>(`/api/webhooks/${encodeURIComponent(webhookId)}`, body)
}

export function deleteWebhook(webhookId: string): Promise<void> {
  return apiDelete(`/api/webhooks/${encodeURIComponent(webhookId)}`)
}

export function listWebhookDeliveries(webhookId: string, limit = 20): Promise<WebhookDelivery[]> {
  return apiGet<WebhookDelivery[]>(
    `/api/webhooks/${encodeURIComponent(webhookId)}/deliveries?limit=${limit}`,
  )
}
