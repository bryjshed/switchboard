import { useContext } from 'react'
import { WorkspaceContext, type WorkspaceState } from '@/context/workspaceContext'

export function useWorkspace(): WorkspaceState {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error('useWorkspace must be used inside <WorkspaceProvider>')
  return ctx
}
