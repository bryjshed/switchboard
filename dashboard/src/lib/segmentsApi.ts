import { apiDelete, apiGet, apiPost, apiPut } from './apiClient'
import type { Segment, SegmentUpsertRequest } from '@/types/api'

function base(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/segments`
}

export function listSegments(projectId: string): Promise<Segment[]> {
  return apiGet<Segment[]>(base(projectId))
}

export function getSegment(projectId: string, segmentKey: string): Promise<Segment> {
  return apiGet<Segment>(`${base(projectId)}/${encodeURIComponent(segmentKey)}`)
}

export function createSegment(projectId: string, body: SegmentUpsertRequest): Promise<Segment> {
  return apiPost<Segment>(base(projectId), body)
}

export function updateSegment(
  projectId: string,
  segmentKey: string,
  body: SegmentUpsertRequest,
): Promise<Segment> {
  return apiPut<Segment>(`${base(projectId)}/${encodeURIComponent(segmentKey)}`, body)
}

/**
 * Rejected with 409 when a flag rule still references the segment. That is a real
 * protection, not a transient failure — callers surface the backend's message (which names
 * the referencing flags) instead of offering a retry.
 */
export function deleteSegment(projectId: string, segmentKey: string): Promise<void> {
  return apiDelete(`${base(projectId)}/${encodeURIComponent(segmentKey)}`)
}
